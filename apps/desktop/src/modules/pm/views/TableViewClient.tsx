"use client";

import type { TaskRow, TaskStatus, TaskPriority } from "@helios/pm-ui";
import {
  STATUS_LABEL,
  STATUS_DOT,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TypeBadge,
  computeCriticalPath,
  criticalityFill,
  daysUntilDue,
  taskOutline,
} from "@helios/pm-ui";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCornerDownRight,
  IconFlag,
  IconLinkPlus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "@pm/lib/router";
import { useScrollMemory } from "@pm/lib/useScrollMemory";
import { memo, useEffect, useMemo, useState } from "react";
import { BulkActionBar } from "@pm/components/BulkActionBar";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { TaskLookup } from "@pm/components/TaskLookup";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { SelectCheckbox } from "@pm/components/ui/SelectCheckbox";
import { StatusLegend } from "@pm/components/StatusLegend";
import { TaskFilterBar } from "@pm/components/TaskFilterBar";
import { usePrimaryOnly } from "@pm/lib/primaryOnly";
import { TaskSubteamChips } from "@pm/components/TaskSubteamChips";
import { ViewHeader } from "@pm/components/ViewHeader";
import {
  EMPTY_FILTERS,
  applyFilters,
  applySort,
  filtersToParams,
  hasScopeFilters,
  parseFilters,
  parseSort,
  taskMatchesScopeFilters,
  type TaskFilters,
  type TaskSort,
} from "@pm/lib/filters";
import {
  scopeTasksToSubteam,
  selectMyRole,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";
import { recallSharing, subsystemsForSubteam } from "@pm/lib/subsystemSharing";

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};

const STATUS_OPTIONS: SelectOption<TaskStatus>[] = TASK_STATUSES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
  swatch: STATUS_DOT[s],
}));

const PRIORITY_OPTIONS: SelectOption<TaskPriority>[] = TASK_PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p],
  fill: criticalityFill(p),
}));

export interface TableViewClientProps {
  teamSlug?: string | null;
}

export function TableViewClient({ teamSlug = null }: TableViewClientProps) {
  // Remember the scroll position per scope so coming back to the table (from
  // another view or a task detail) lands where the user left off.
  const scrollMemRef = useScrollMemory(`table:${teamSlug ?? "__project__"}`);
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const deps = usePmStore((s) => s.dependencies);
  const projectId = usePmStore((s) => s.projectId);
  const activeProjectId = usePmStore((s) => s.activeProjectId);
  const addTask = usePmStore((s) => s.addTask);
  const updateTask = usePmStore((s) => s.updateTask);
  const deleteTask = usePmStore((s) => s.deleteTask);
  const selectTask = usePmStore((s) => s.selectTask);
  const selectedTaskIds = usePmStore((s) => s.selectedTaskIds);
  const toggleSelected = usePmStore((s) => s.toggleSelected);
  const setSelection = usePmStore((s) => s.setSelection);
  const clearSelection = usePmStore((s) => s.clearSelection);
  // Viewers can't write — mirror their (RLS-rejected) edits by disabling the
  // inline dropdowns so the value never optimistically flips then snaps back.
  const isViewer = usePmStore(selectMyRole) === "viewer";

  const currentTeam = teamSlug
    ? subteams.find((s) => s.slug === teamSlug) ?? null
    : null;

  // Defense-in-depth: a selection made in one team scope must not survive a
  // cross-team navigation (it could reference rows that are external/RLS-denied
  // here). Clear it whenever the team scope changes so the bulk bar disappears.
  useEffect(() => {
    clearSelection();
  }, [teamSlug, clearSelection]);

  const router = useRouter();
  const sp = useSearchParams();
  const filters = useMemo(() => parseFilters(sp), [sp]);
  const sort = useMemo(() => parseSort(sp), [sp]);

  const critical = useMemo(() => computeCriticalPath(tasks, deps), [tasks, deps]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  // When set, the "add existing subtask" picker is open for this parent task id.
  const [linkParentId, setLinkParentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [subsystemFilter, setSubsystemFilter] = useState<string | null>(null);

  const [primaryOnly, setPrimaryOnly] = usePrimaryOnly();

  // Compute visible tasks. For global view, every task. For subteam view,
  // owned tasks + external tasks linked by a dependency edge.
  const scopedRows = useMemo(() => {
    if (!currentTeam) {
      return tasks.map((task) => ({
        task,
        relation: "owned" as CrossTeamRelation,
        bridgeTaskIds: [] as string[],
      }));
    }
    return scopeTasksToSubteam(tasks, deps, currentTeam.id, primaryOnly);
  }, [tasks, deps, currentTeam, primaryOnly]);

  const relationByTaskId = useMemo(() => {
    const m = new Map<string, CrossTeamRelation>();
    for (const r of scopedRows) m.set(r.task.id, r.relation);
    return m;
  }, [scopedRows]);

  // Subsystem chips (only meaningful inside a subteam scope)
  const teamSubsystems = useMemo(() => {
    if (!currentTeam) return [];
    return subsystems.filter((s) => s.subteam_id === currentTeam.id);
  }, [subsystems, currentTeam]);

  const baseVisible = useMemo(() => {
    let arr: TaskRow[] = scopedRows.map((r) => r.task);
    if (currentTeam && subsystemFilter) {
      arr = arr.filter((t) => {
        // For owned tasks, match subsystem strictly. For external tasks,
        // always include (they bridge to the team).
        if (t.subteam_id !== currentTeam.id) return true;
        return t.subsystem_id === subsystemFilter;
      });
    }
    return arr;
  }, [scopedRows, currentTeam, subsystemFilter]);

  function updateUrl(next: TaskFilters, nextSort: TaskSort) {
    const params = filtersToParams(next, nextSort);
    const qs = params.toString();
    const base = currentTeam ? `/team/${currentTeam.slug}/table` : "/table";
    router.replace(qs ? `${base}?${qs}` : base, { scroll: false });
  }

  function patchFilters(patch: Partial<TaskFilters>) {
    updateUrl({ ...filters, ...patch }, sort);
  }

  function toggleSort(key: TaskSort["key"]) {
    let nextDir: TaskSort["dir"] = "asc";
    if (sort.key === key) nextDir = sort.dir === "asc" ? "desc" : "asc";
    updateUrl(filters, { key, dir: nextDir });
  }

  const visibleParents = useMemo(() => {
    const filteredAll = applyFilters(baseVisible, filters);
    const idsInFilter = new Set(filteredAll.map((t) => t.id));
    const roots = baseVisible.filter(
      (t) =>
        idsInFilter.has(t.id) &&
        (t.parent_task_id === null || !idsInFilter.has(t.parent_task_id)),
    );
    return applySort(roots, sort);
  }, [baseVisible, filters, sort]);

  const childrenOf = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const t of baseVisible) {
      if (t.parent_task_id) {
        const arr = map.get(t.parent_task_id) ?? [];
        arr.push(t);
        map.set(t.parent_task_id, arr);
      }
    }
    return map;
  }, [baseVisible]);

  // Tasks rendered DIMMED: they match the base filters but fall outside the
  // subteam/type scope filters in "dim" show-mode. They read as filter-excluded,
  // so select-all must not sweep them up (in "hide" mode they're already gone).
  const dimmedById = useMemo(() => {
    const out = new Set<string>();
    if (!hasScopeFilters(filters) || filters.showMode !== "dim") return out;
    for (const t of baseVisible) {
      if (!taskMatchesScopeFilters(t, filters)) out.add(t.id);
    }
    return out;
  }, [baseVisible, filters]);

  // The OWNED ids of every row currently RENDERED and not dimmed, for "select
  // all filtered". A parent's children are only rendered when that parent is
  // expanded, so we recurse into childrenOf only for expanded rows — otherwise
  // select-all and the header tri-state would count collapsed/hidden
  // descendants. External/cross-team rows are excluded so a bulk .in() write
  // never touches an RLS-denied row (which would roll the whole atomic batch
  // back); dimmed (filter-excluded) rows are excluded so select-all only ever
  // covers the visible, in-scope tasks.
  const selectableIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = (t: TaskRow) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      if ((relationByTaskId.get(t.id) ?? "owned") === "owned" && !dimmedById.has(t.id)) {
        ids.push(t.id);
      }
      // Only descend into children that are actually on screen (parent open).
      if (expanded.has(t.id)) {
        for (const child of childrenOf.get(t.id) ?? []) walk(child);
      }
    };
    for (const root of visibleParents) walk(root);
    return ids;
  }, [visibleParents, childrenOf, relationByTaskId, expanded, dimmedById]);

  const selectableSet = useMemo(() => new Set(selectableIds), [selectableIds]);
  const selectedInView = selectableIds.filter((id) => selectedTaskIds.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectedInView === selectableIds.length;
  const someSelected = selectedInView > 0 && !allSelected;

  function toggleSelectAll() {
    if (allSelected) {
      // Deselect only the in-view ids; keep any selection outside this view.
      setSelection([...selectedTaskIds].filter((id) => !selectableSet.has(id)));
    } else {
      setSelection([...new Set([...selectedTaskIds, ...selectableIds])]);
    }
  }

  const filtersActive =
    filters.status.length > 0 ||
    filters.subteamIds.length > 0 ||
    filters.types.length > 0 ||
    filters.ownerIds.length > 0 ||
    filters.dueFrom !== null ||
    filters.dueTo !== null ||
    filters.search.length > 0;

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Multi-subteam sharing overlay (localStorage) so a subsystem shared to a
  // subteam still shows up for that subteam's tasks. Keyed by project.
  const sharing = useMemo(() => recallSharing(activeProjectId), [activeProjectId]);

  // Subsystems offered for a task: only those of its PRIMARY subteam (plus any
  // shared to it), with a "No subsystem" clear option first. Memoized per subteam
  // (the options depend only on the subteam, its subsystems, and the sharing
  // overlay) so the SAME array reference is returned across renders — without this
  // a fresh array each render would defeat the memoized row's bailout (bug #10).
  const subsystemOptionsByTeam = useMemo(() => {
    const cache = new Map<string, SelectOption<string>[]>();
    return (task: TaskRow): SelectOption<string>[] => {
      const cached = cache.get(task.subteam_id);
      if (cached) return cached;
      const opts: SelectOption<string>[] = [{ value: "", label: "No subsystem" }];
      for (const ss of subsystemsForSubteam(subsystems, task.subteam_id, sharing)) {
        opts.push({ value: ss.id, label: ss.name, swatch: ss.color ?? task.subteam.color ?? "#6B7280" });
      }
      cache.set(task.subteam_id, opts);
      return opts;
    };
  }, [subsystems, sharing]);
  const subsystemOptionsFor = subsystemOptionsByTeam;

  function renderRow(task: TaskRow, depth: number) {
    const kids = childrenOf.get(task.id) ?? [];
    const isOpen = expanded.has(task.id);
    const isCritical = critical.has(task.id);
    const relation = relationByTaskId.get(task.id) ?? "owned";
    const dimmed = dimmedById.has(task.id);

    return (
      <RowFragment
        key={task.id}
        task={task}
        depth={depth}
        kids={kids}
        isOpen={isOpen}
        isCritical={isCritical}
        relation={relation}
        dimmed={dimmed}
        users={users}
        isViewer={isViewer}
        selected={selectedTaskIds.has(task.id)}
        onToggleSelect={() => toggleSelected(task.id)}
        onOpen={() => selectTask(task.id)}
        onToggle={() => toggleRow(task.id)}
        onChangeStatus={(s) => updateTask(task.id, { status: s })}
        onChangeOwner={(id) => updateTask(task.id, { owner_id: id })}
        onChangeDue={(d) => updateTask(task.id, { due_date: d })}
        onChangePriority={(p) => updateTask(task.id, { priority: p })}
        subsystemOptions={subsystemOptionsFor(task)}
        onChangeSubsystem={(id) => updateTask(task.id, { subsystem_id: id || null })}
        onAddSubtask={() => {
          setCreateParentId(task.id);
          setDialogOpen(true);
        }}
        onAddExisting={() => setLinkParentId(task.id)}
        onDelete={() => {
          if (confirm(`Delete task "${task.title}"? This cannot be undone.`))
            deleteTask(task.id);
        }}
      >
        {isOpen
          ? applySort(kids, sort).map((child) => renderRow(child, depth + 1))
          : null}
      </RowFragment>
    );
  }

  const ownedCount = scopedRows.filter((r) => r.relation === "owned").length;
  const externalCount = scopedRows.length - ownedCount;

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Table` : "Tasks"}
        description={
          currentTeam
            ? `${ownedCount} owned · ${externalCount} cross-team`
            : `${visibleParents.length} root task${visibleParents.length === 1 ? "" : "s"} · ${tasks.length} total`
        }
        actions={
          <button
            type="button"
            onClick={() => {
              setCreateParentId(null);
              setDialogOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90"
          >
            <IconPlus size={16} strokeWidth={1.5} />
            New task
          </button>
        }
      />

      {currentTeam && teamSubsystems.length > 0 ? (
        <SubsystemChips
          subsystems={teamSubsystems}
          active={subsystemFilter}
          onPick={(id) => setSubsystemFilter(id)}
        />
      ) : null}

      <TaskFilterBar
        filters={filters}
        subteams={subteams}
        users={users}
        active={filtersActive}
        scopedToTeam={currentTeam !== null}
        primaryOnly={primaryOnly}
        onPrimaryOnlyChange={setPrimaryOnly}
        onPatch={patchFilters}
        onClear={() => updateUrl(EMPTY_FILTERS, sort)}
      />

      <div ref={scrollMemRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="overflow-x-auto rounded-md border border-helios-line bg-helios-panel">
          <table className="w-full text-left text-sm text-helios-text">
            <thead className="border-b border-helios-line text-helios-dim">
              <tr>
                <th className="w-9 px-3 py-2">
                  <SelectCheckbox
                    ariaLabel="Select all filtered tasks"
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={selectableIds.length === 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <SortHeader label="Title"     active={sort.key === "title"}     dir={sort.dir} onClick={() => toggleSort("title")} />
                <th className="px-3 py-2 font-medium">Type</th>
                <SortHeader label="Subteam"   active={sort.key === "subsystem"} dir={sort.dir} onClick={() => toggleSort("subsystem")} />
                <th className="px-3 py-2 font-medium">Subsystem</th>
                <SortHeader label="Owner"     active={sort.key === "owner"}     dir={sort.dir} onClick={() => toggleSort("owner")} />
                <SortHeader label="Status"    active={sort.key === "status"}    dir={sort.dir} onClick={() => toggleSort("status")} />
                <SortHeader label="Priority"  active={sort.key === "priority"}  dir={sort.dir} onClick={() => toggleSort("priority")} />
                <SortHeader label="Due"       active={sort.key === "due_date"}  dir={sort.dir} onClick={() => toggleSort("due_date")} />
                <th className="px-3 py-2 text-right font-medium">Days</th>
                <th className="px-3 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-helios-line">
              {visibleParents.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-helios-dim">
                    No tasks match the current filters.
                  </td>
                </tr>
              ) : (
                visibleParents.map((t) => renderRow(t, 0))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <StatusLegend />
        </div>
      </div>

      <CreateTaskDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setCreateParentId(null);
        }}
        onCreate={(task, extra) => {
          // If we're in a subteam scope, force the new task into this team
          const reHomed = !!(currentTeam && task.subteam_id !== currentTeam.id);
          const teamPatched =
            currentTeam && reHomed
              ? { ...task, subteam_id: currentTeam.id, subteam: currentTeam, subsystem_id: null, subsystem: null }
              : task;
          const finalTask = createParentId
            ? { ...teamPatched, parent_task_id: createParentId }
            : teamPatched;
          // Drop the scoped team from staged extras when re-homing the primary
          // to it, so it isn't also added as a stray secondary membership.
          const scopedExtra =
            reHomed && currentTeam && extra
              ? { ...extra, extraSubteamIds: (extra.extraSubteamIds ?? []).filter((id) => id !== currentTeam.id) }
              : extra;
          addTask(finalTask, scopedExtra);
          if (createParentId) {
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(createParentId);
              return next;
            });
          }
        }}
        projectId={projectId}
        subteams={subteams}
        subsystems={subsystems}
        users={users}
        defaultSubteamId={currentTeam?.id ?? null}
      />

      {linkParentId
        ? (() => {
            const parent = tasks.find((t) => t.id === linkParentId);
            if (!parent) return null;
            // Forbid picking the parent itself or any of its ancestors (cycle-safe).
            const byId = new Map(tasks.map((t) => [t.id, t]));
            const exclude = new Set<string>([linkParentId]);
            let cur: string | null = parent.parent_task_id;
            while (cur && !exclude.has(cur)) {
              exclude.add(cur);
              cur = byId.get(cur)?.parent_task_id ?? null;
            }
            return (
              <FloatingWindow
                open
                title="Add existing subtask"
                onClose={() => setLinkParentId(null)}
                initialWidth={420}
                initialHeight={300}
              >
                <div className="p-3">
                  <p className="mb-2 text-xs text-helios-dim">
                    Pick an existing task to make it a subtask of{" "}
                    <span className="text-helios-text">{parent.title}</span>.
                  </p>
                  <TaskLookup
                    tasks={tasks}
                    excludeIds={exclude}
                    onSelect={(id) => {
                      updateTask(id, { parent_task_id: linkParentId });
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        next.add(linkParentId);
                        return next;
                      });
                      setLinkParentId(null);
                    }}
                    placeholder="Search tasks by title…"
                  />
                </div>
              </FloatingWindow>
            );
          })()
        : null}

      <BulkActionBar selectableIds={selectableSet} />
    </>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={onClick}
        className={
          "inline-flex items-center gap-1 transition-colors " +
          (active ? "text-helios-text" : "hover:text-helios-text")
        }
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <IconArrowUp size={12} strokeWidth={1.5} />
          ) : (
            <IconArrowDown size={12} strokeWidth={1.5} />
          )
        ) : null}
      </button>
    </th>
  );
}

function RowFragmentInner({
  task,
  depth,
  kids,
  isOpen,
  isCritical,
  relation,
  dimmed,
  users,
  isViewer,
  selected,
  onToggleSelect,
  onOpen,
  onToggle,
  onChangeStatus,
  onChangeOwner,
  onChangeDue,
  onChangePriority,
  subsystemOptions,
  onChangeSubsystem,
  onAddSubtask,
  onAddExisting,
  onDelete,
  children,
}: {
  task: TaskRow;
  depth: number;
  kids: TaskRow[];
  isOpen: boolean;
  isCritical: boolean;
  relation: CrossTeamRelation;
  dimmed: boolean;
  users: ReadonlyArray<{ id: string; name: string }>;
  isViewer: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onToggle: () => void;
  onChangeStatus: (s: TaskStatus) => void;
  onChangeOwner: (id: string | null) => void;
  onChangeDue: (d: string | null) => void;
  onChangePriority: (p: TaskPriority) => void;
  subsystemOptions: SelectOption<string>[];
  onChangeSubsystem: (id: string) => void;
  onAddSubtask: () => void;
  onAddExisting: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  const isExternal = relation !== "owned";
  // Viewers + external (cross-team) rows are read-only for inline edits.
  const editsDisabled = isExternal || isViewer;
  const outline = taskOutline(task);
  const days = daysUntilDue(task.due_date);
  return (
    <>
      <tr
        className={
          "group " +
          (dimmed ? "opacity-30 " : "") +
          (isExternal
            ? "bg-helios-base/30 hover:bg-helios-base/50"
            : "hover:bg-helios-base/40")
        }
      >
        <td className="w-9 px-3 py-2 align-middle">
          <SelectCheckbox
            ariaLabel={`Select task ${task.title}`}
            checked={selected}
            disabled={isExternal}
            onChange={onToggleSelect}
          />
        </td>
        <td
          className="px-3 py-2"
          style={{ borderLeft: `3px solid ${outline.borderColor}` }}
        >
          <div
            className="flex items-center gap-1.5"
            style={{ paddingLeft: depth === 0 ? 0 : depth * 18 }}
          >
            {depth > 0 ? (
              <IconCornerDownRight
                size={12}
                strokeWidth={1.5}
                className="text-helios-dim"
              />
            ) : null}
            {kids.length > 0 ? (
              <button
                type="button"
                onClick={onToggle}
                className="text-helios-dim hover:text-helios-text"
                aria-label={isOpen ? "Collapse" : "Expand"}
              >
                {isOpen ? (
                  <IconChevronDown size={14} strokeWidth={1.5} />
                ) : (
                  <IconChevronRight size={14} strokeWidth={1.5} />
                )}
              </button>
            ) : (
              <span className="inline-block w-3.5" />
            )}
            {isCritical ? (
              <IconFlag
                size={12}
                strokeWidth={1.5}
                className="text-asu-gold"
                aria-label="On critical path"
              />
            ) : null}
            <button
              type="button"
              onClick={onOpen}
              className={
                "rounded text-left font-normal hover:underline " +
                (isExternal ? "italic text-helios-text/80" : "text-helios-text")
              }
            >
              {task.title}
            </button>
            {isExternal ? <RelationChip relation={relation} /> : null}
          </div>
        </td>
        <td className="px-3 py-2">
          <TypeBadge type={task.type} />
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <TaskSubteamChips task={task} />
          </span>
        </td>
        <td className="px-3 py-2">
          <Select
            size="sm"
            value={task.subsystem_id ?? ""}
            disabled={editsDisabled}
            ariaLabel="Subsystem"
            placeholder="—"
            className="min-w-[8rem]"
            options={subsystemOptions}
            onChange={(v) => onChangeSubsystem(v)}
          />
        </td>
        <td className="px-3 py-2">
          <Select
            size="sm"
            value={task.owner_id ?? ""}
            disabled={editsDisabled}
            ariaLabel="Owner"
            onChange={(v) => onChangeOwner(v === "" ? null : v)}
            options={[
              { value: "", label: "Unassigned" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </td>
        <td className="px-3 py-2">
          <Select
            size="sm"
            value={task.status}
            disabled={editsDisabled}
            ariaLabel="Status"
            onChange={(v) => onChangeStatus(v)}
            options={STATUS_OPTIONS}
          />
        </td>
        <td className="px-1.5 py-1.5">
          <Select
            size="sm"
            value={task.priority}
            disabled={editsDisabled}
            ariaLabel="Priority"
            onChange={(v) => onChangePriority(v)}
            options={PRIORITY_OPTIONS}
          />
        </td>
        <td className="px-3 py-2 tabular-nums">
          <input
            type="date"
            className={selectInline}
            value={task.due_date ?? ""}
            disabled={editsDisabled}
            onChange={(e) =>
              onChangeDue(e.target.value === "" ? null : e.target.value)
            }
          />
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <CountdownCell days={days} done={task.status === "done"} />
        </td>
        <td className="px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {!isExternal ? (
              <>
                <button
                  type="button"
                  onClick={onAddSubtask}
                  className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
                  title="Add new subtask"
                  aria-label="Add new subtask"
                >
                  <IconPlus size={14} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={onAddExisting}
                  className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
                  title="Add existing task as subtask"
                  aria-label="Add existing task as subtask"
                >
                  <IconLinkPlus size={14} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-red-400"
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <IconTrash size={14} strokeWidth={1.5} />
                </button>
              </>
            ) : null}
          </div>
        </td>
      </tr>
      {children}
    </>
  );
}

// Memoized so a render that doesn't touch a given row's DATA bails out instead of
// re-rendering every row (bug: renderRow built fresh closures every render, so
// even unchanged rows re-rendered). The per-row callback props are inline arrows
// rebuilt each render, but they only ever close over the row's `task.id` and the
// stable store actions, so they are BEHAVIORALLY identical across renders for the
// same row — the comparator therefore ignores the function props and compares
// only the data props (incl. `children`, which carries nested rows). Leaf rows
// (children === null) bail out cleanly; parents still re-render when their
// subtree changes, which is correct.
const RowFragment = memo(RowFragmentInner, (prev, next) => {
  return (
    prev.task === next.task &&
    prev.depth === next.depth &&
    prev.kids === next.kids &&
    prev.isOpen === next.isOpen &&
    prev.isCritical === next.isCritical &&
    prev.relation === next.relation &&
    prev.dimmed === next.dimmed &&
    prev.users === next.users &&
    prev.isViewer === next.isViewer &&
    prev.selected === next.selected &&
    prev.subsystemOptions === next.subsystemOptions &&
    prev.children === next.children
  );
});

function CountdownCell({ days, done }: { days: number | null; done: boolean }) {
  if (days === null) return <span className="text-helios-dim">—</span>;
  if (done) return <span className="text-emerald-400">done</span>;
  if (days < 0)
    return <span className="text-red-400">{Math.abs(days)}d over</span>;
  if (days === 0) return <span className="text-orange-400">today</span>;
  const tone = days <= 7 ? "text-orange-400" : "text-helios-text";
  return <span className={tone}>{days}d</span>;
}

function RelationChip({ relation }: { relation: CrossTeamRelation }) {
  if (relation === "prerequisite_of_team") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-blue-400/40 px-1.5 py-0 text-[10px] font-medium uppercase tracking-widest text-blue-300">
        <IconArrowLeft size={10} strokeWidth={1.5} />
        Prerequisite
      </span>
    );
  }
  if (relation === "dependent_on_team") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 px-1.5 py-0 text-[10px] font-medium uppercase tracking-widest text-amber-300">
        <IconArrowRight size={10} strokeWidth={1.5} />
        Dependent
      </span>
    );
  }
  return null;
}

const selectInline =
  "rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-normal text-helios-text " +
  "hover:border-helios-line focus:border-asu-gold focus:outline-none disabled:opacity-60 disabled:hover:border-transparent";

function SubsystemChips({
  subsystems,
  active,
  onPick,
}: {
  subsystems: ReadonlyArray<{ id: string; name: string; color: string | null }>;
  active: string | null;
  onPick: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-helios-line bg-helios-panel/40 px-6 py-2">
      <span className="mr-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        Subsystem
      </span>
      <button
        type="button"
        onClick={() => onPick(null)}
        className={
          "rounded-full border px-2 py-0.5 text-xs font-normal transition-colors " +
          (active === null
            ? "border-helios-text/40 bg-helios-base text-helios-text"
            : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
        }
      >
        All
      </button>
      {subsystems.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s.id)}
          className={
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-normal transition-colors " +
            (active === s.id
              ? "border-helios-text/40 bg-helios-base text-helios-text"
              : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
          }
        >
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ backgroundColor: s.color ?? "#6B7280" }}
          />
          {s.name}
        </button>
      ))}
    </div>
  );
}

