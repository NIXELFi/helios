"use client";

import type { TaskRow, TaskStatus, TaskPriority } from "@helios/pm-ui";
import {
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
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "@pm/lib/router";
import { useMemo, useState } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { StatusLegend } from "@pm/components/StatusLegend";
import { TaskFilterBar } from "@pm/components/TaskFilterBar";
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
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  designing: "Designing",
  manufacturing: "Manufacturing",
  testing: "Testing",
  needs_review: "Needs review",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_DOT_HEX: Record<TaskStatus, string> = {
  backlog: "#9097A0",
  designing: "#60A5FA",
  manufacturing: "#FBBF24",
  testing: "#A78BFA",
  needs_review: "#FFC627",
  blocked: "#F87171",
  done: "#34D399",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};

const STATUS_OPTIONS: SelectOption<TaskStatus>[] = TASK_STATUSES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
  swatch: STATUS_DOT_HEX[s],
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
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const deps = usePmStore((s) => s.dependencies);
  const projectId = usePmStore((s) => s.projectId);
  const addTask = usePmStore((s) => s.addTask);
  const updateTask = usePmStore((s) => s.updateTask);
  const deleteTask = usePmStore((s) => s.deleteTask);
  const selectTask = usePmStore((s) => s.selectTask);

  const currentTeam = teamSlug
    ? subteams.find((s) => s.slug === teamSlug) ?? null
    : null;

  const router = useRouter();
  const sp = useSearchParams();
  const filters = useMemo(() => parseFilters(sp), [sp]);
  const sort = useMemo(() => parseSort(sp), [sp]);

  const critical = useMemo(() => computeCriticalPath(tasks, deps), [tasks, deps]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [subsystemFilter, setSubsystemFilter] = useState<string | null>(null);

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
    return scopeTasksToSubteam(tasks, deps, currentTeam.id);
  }, [tasks, deps, currentTeam]);

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

  const filtersActive =
    filters.status.length > 0 ||
    filters.subteamIds.length > 0 ||
    filters.types.length > 0 ||
    filters.ownerIds.length > 0 ||
    filters.dueFrom !== null ||
    filters.dueTo !== null ||
    filters.search.length > 0;

  // Tasks that match the existing filters but fall outside the scope filters
  // (subteam + type) should render dimmed when showMode = "dim". In "hide" mode
  // they're filtered out upstream via applyFilters in filters.ts.
  const dimmedById = useMemo(() => {
    const out = new Set<string>();
    if (!hasScopeFilters(filters) || filters.showMode !== "dim") return out;
    for (const t of baseVisible) {
      if (!taskMatchesScopeFilters(t, filters)) out.add(t.id);
    }
    return out;
  }, [baseVisible, filters]);

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        onOpen={() => selectTask(task.id)}
        onToggle={() => toggleRow(task.id)}
        onChangeStatus={(s) => updateTask(task.id, { status: s })}
        onChangeOwner={(id) => updateTask(task.id, { owner_id: id })}
        onChangeDue={(d) => updateTask(task.id, { due_date: d })}
        onChangePriority={(p) => updateTask(task.id, { priority: p })}
        onAddSubtask={() => {
          setCreateParentId(task.id);
          setDialogOpen(true);
        }}
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
        onPatch={patchFilters}
        onClear={() => updateUrl(EMPTY_FILTERS, sort)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="overflow-x-auto rounded-md border border-helios-line bg-helios-panel">
          <table className="w-full text-left text-sm text-helios-text">
            <thead className="border-b border-helios-line text-helios-dim">
              <tr>
                <SortHeader label="Title"     active={sort.key === "title"}     dir={sort.dir} onClick={() => toggleSort("title")} />
                <th className="px-3 py-2 font-medium">Type</th>
                <SortHeader label="Subteam"   active={sort.key === "subsystem"} dir={sort.dir} onClick={() => toggleSort("subsystem")} />
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
                  <td colSpan={9} className="px-4 py-10 text-center text-helios-dim">
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
        onCreate={(task) => {
          // If we're in a subteam scope, force the new task into this team
          const teamPatched =
            currentTeam && task.subteam_id !== currentTeam.id
              ? { ...task, subteam_id: currentTeam.id, subteam: currentTeam, subsystem_id: null, subsystem: null }
              : task;
          const finalTask = createParentId
            ? { ...teamPatched, parent_task_id: createParentId }
            : teamPatched;
          addTask(finalTask);
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

function RowFragment({
  task,
  depth,
  kids,
  isOpen,
  isCritical,
  relation,
  dimmed,
  users,
  onOpen,
  onToggle,
  onChangeStatus,
  onChangeOwner,
  onChangeDue,
  onChangePriority,
  onAddSubtask,
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
  onOpen: () => void;
  onToggle: () => void;
  onChangeStatus: (s: TaskStatus) => void;
  onChangeOwner: (id: string | null) => void;
  onChangeDue: (d: string | null) => void;
  onChangePriority: (p: TaskPriority) => void;
  onAddSubtask: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  const isExternal = relation !== "owned";
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
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: task.subteam.color ?? "#6B7280" }}
            />
            {task.subteam.name}
            {task.subsystem ? (
              <span className="text-helios-dim">· {task.subsystem.name}</span>
            ) : null}
          </span>
        </td>
        <td className="px-3 py-2">
          <Select
            size="sm"
            value={task.owner_id ?? ""}
            disabled={isExternal}
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
            disabled={isExternal}
            ariaLabel="Status"
            onChange={(v) => onChangeStatus(v)}
            options={STATUS_OPTIONS}
          />
        </td>
        <td className="px-1.5 py-1.5">
          <Select
            size="sm"
            value={task.priority}
            disabled={isExternal}
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
            disabled={isExternal}
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
                  title="Add subtask"
                  aria-label="Add subtask"
                >
                  <IconPlus size={14} strokeWidth={1.5} />
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

