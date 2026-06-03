"use client";

import type { TaskRow, TaskStatus } from "@helios/pm-ui";
import { STATUS_LABEL, TASK_STATUSES, TypeBadge, taskOutline } from "@helios/pm-ui";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  IconArrowLeft,
  IconArrowRight,
  IconFlag,
  IconPlus,
  IconUserCircle,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "@pm/lib/router";
import { useEffect, useMemo, useState } from "react";
import { BulkActionBar } from "@pm/components/BulkActionBar";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { SelectCheckbox } from "@pm/components/ui/SelectCheckbox";
import { StatusLegend } from "@pm/components/StatusLegend";
import { TaskFilterBar } from "@pm/components/TaskFilterBar";
import { TaskSubteamChips } from "@pm/components/TaskSubteamChips";
import { ViewHeader } from "@pm/components/ViewHeader";
import {
  EMPTY_FILTERS,
  applyHardFilters,
  filtersToParams,
  hasScopeFilters,
  parseFilters,
  parseSort,
  taskMatchesScopeFilters,
  type TaskFilters,
} from "@pm/lib/filters";
import {
  scopeTasksToSubteam,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

const STATUS_ACCENT: Record<TaskStatus, string> = {
  not_started: "border-helios-line",
  in_progress: "border-blue-400/40",
  needs_review: "border-asu-gold/40",
  blocked: "border-red-400/40",
  done: "border-emerald-400/40",
};

const PRIORITY_TONE = {
  low: "text-helios-dim",
  medium: "text-helios-text",
  high: "text-asu-gold",
  critical: "text-red-400",
};

export interface BoardViewClientProps {
  teamSlug?: string | null;
}

export function BoardViewClient({ teamSlug = null }: BoardViewClientProps) {
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const deps = usePmStore((s) => s.dependencies);
  const projectId = usePmStore((s) => s.projectId);
  const addTask = usePmStore((s) => s.addTask);
  const updateTask = usePmStore((s) => s.updateTask);
  const selectTask = usePmStore((s) => s.selectTask);
  const selectedTaskIds = usePmStore((s) => s.selectedTaskIds);
  const toggleSelected = usePmStore((s) => s.toggleSelected);
  const clearSelection = usePmStore((s) => s.clearSelection);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;

  // Defense-in-depth: drop any selection when the team scope changes so a stale
  // (possibly external/RLS-denied) selection can't survive cross-team nav.
  useEffect(() => {
    clearSelection();
  }, [teamSlug, clearSelection]);

  const router = useRouter();
  const sp = useSearchParams();
  const filters = useMemo(() => parseFilters(sp), [sp]);
  const sort = useMemo(() => parseSort(sp), [sp]);

  const [dialogOpen, setDialogOpen] = useState(false);

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

  const baseTasks = useMemo(() => scopedRows.map((r) => r.task), [scopedRows]);

  // Apply hard filters; scope filters (subteam/type) either hide or dim.
  const filteredTasks = useMemo(() => {
    const hard = applyHardFilters(baseTasks, filters);
    if (filters.showMode === "hide" && hasScopeFilters(filters)) {
      return hard.filter((t) => taskMatchesScopeFilters(t, filters));
    }
    return hard;
  }, [baseTasks, filters]);

  const dimmedById = useMemo(() => {
    const out = new Set<string>();
    if (!hasScopeFilters(filters) || filters.showMode !== "dim") return out;
    for (const t of filteredTasks) {
      if (!taskMatchesScopeFilters(t, filters)) out.add(t.id);
    }
    return out;
  }, [filteredTasks, filters]);

  // The OWNED ids of every card currently rendered. Only these get a checkbox
  // (external cards are read-only context), so the bulk bar must intersect the
  // selection against this set before issuing any atomic .in() write.
  const selectableSet = useMemo(() => {
    const out = new Set<string>();
    for (const t of filteredTasks) {
      if ((relationByTaskId.get(t.id) ?? "owned") === "owned") out.add(t.id);
    }
    return out;
  }, [filteredTasks, relationByTaskId]);

  const filtersActive =
    filters.status.length > 0 ||
    filters.subteamIds.length > 0 ||
    filters.types.length > 0 ||
    filters.ownerIds.length > 0 ||
    filters.dueFrom !== null ||
    filters.dueTo !== null ||
    filters.search.length > 0;

  function updateUrl(next: TaskFilters) {
    const params = filtersToParams(next, sort);
    const qs = params.toString();
    const base = currentTeam ? `/team/${currentTeam.slug}/board` : "/board";
    router.replace(qs ? `${base}?${qs}` : base, { scroll: false });
  }

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, TaskRow[]>();
    for (const s of TASK_STATUSES) m.set(s, []);
    for (const t of filteredTasks) {
      const arr = m.get(t.status) ?? [];
      arr.push(t);
      m.set(t.status, arr);
    }
    return m;
  }, [filteredTasks]);

  const activeTask = activeId ? filteredTasks.find((t) => t.id === activeId) ?? null : null;

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    if (!e.over) return;
    const taskId = String(e.active.id);
    const destStatus = String(e.over.id) as TaskStatus;
    const task = filteredTasks.find((t) => t.id === taskId);
    if (!task || task.status === destStatus) return;
    const relation = relationByTaskId.get(taskId) ?? "owned";
    if (relation !== "owned") return; // Can't mutate external tasks from a subteam scope
    updateTask(taskId, { status: destStatus });
  }

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Board` : "Board"}
        description={
          currentTeam
            ? "Drag owned cards between columns · external cards (faded) shown for context"
            : `Drag cards between columns to change status · ${filteredTasks.length} tasks`
        }
        actions={
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90"
          >
            <IconPlus size={16} strokeWidth={1.5} />
            New task
          </button>
        }
      />

      <TaskFilterBar
        filters={filters}
        subteams={subteams}
        users={users}
        active={filtersActive}
        scopedToTeam={currentTeam !== null}
        onPatch={(patch) => updateUrl({ ...filters, ...patch })}
        onClear={() => updateUrl(EMPTY_FILTERS)}
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex min-w-max gap-4">
            {TASK_STATUSES.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={byStatus.get(status) ?? []}
                relations={relationByTaskId}
                dimmedById={dimmedById}
                selectedIds={selectedTaskIds}
                onToggleSelect={toggleSelected}
                onOpen={selectTask}
              />
            ))}
          </div>

          <DragOverlay>
            {activeTask ? (
              <Card task={activeTask} relation={relationByTaskId.get(activeTask.id) ?? "owned"} dragging />
            ) : null}
          </DragOverlay>
        </DndContext>

        <div className="mt-4">
          <StatusLegend />
        </div>
      </div>

      <CreateTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={(task) => {
          const teamPatched =
            currentTeam && task.subteam_id !== currentTeam.id
              ? { ...task, subteam_id: currentTeam.id, subteam: currentTeam, subsystem_id: null, subsystem: null }
              : task;
          addTask(teamPatched);
        }}
        projectId={projectId}
        subteams={subteams}
        subsystems={subsystems}
        users={users}
        defaultSubteamId={currentTeam?.id ?? null}
      />

      <BulkActionBar selectableIds={selectableSet} />
    </>
  );
}

function Column({
  status,
  tasks,
  relations,
  dimmedById,
  selectedIds,
  onToggleSelect,
  onOpen,
}: {
  status: TaskStatus;
  tasks: TaskRow[];
  relations: Map<string, CrossTeamRelation>;
  dimmedById: Set<string>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={
        `flex w-72 shrink-0 flex-col rounded-md border bg-helios-panel/50 ${STATUS_ACCENT[status]} ` +
        (isOver ? "ring-1 ring-asu-gold/60" : "")
      }
    >
      <div className="flex items-center justify-between border-b border-helios-line px-3 py-2">
        <span className="text-sm font-medium text-helios-text">
          {STATUS_LABEL[status]}
        </span>
        <span className="text-xs font-normal text-helios-dim tabular-nums">
          {tasks.length}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-2">
        {tasks.length === 0 ? (
          <div className="rounded border border-dashed border-helios-line/60 p-4 text-center text-xs text-helios-dim">
            Drop tasks here
          </div>
        ) : (
          tasks.map((t) => (
            <DraggableCard
              key={t.id}
              task={t}
              relation={relations.get(t.id) ?? "owned"}
              dimmed={dimmedById.has(t.id)}
              selected={selectedIds.has(t.id)}
              onToggleSelect={() => onToggleSelect(t.id)}
              onOpen={() => onOpen(t.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DraggableCard({
  task,
  relation,
  dimmed,
  selected,
  onToggleSelect,
  onOpen,
}: {
  task: TaskRow;
  relation: CrossTeamRelation;
  dimmed: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  const disabled = relation !== "owned";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={(isDragging ? "opacity-30 " : "") + (dimmed ? "opacity-30" : "")}
    >
      <Card
        task={task}
        relation={relation}
        selected={selected}
        onToggleSelect={onToggleSelect}
        onOpen={onOpen}
      />
    </div>
  );
}

function Card({
  task,
  relation,
  dragging = false,
  selected = false,
  onToggleSelect,
  onOpen,
}: {
  task: TaskRow;
  relation: CrossTeamRelation;
  dragging?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onOpen?: () => void;
}) {
  const isExternal = relation !== "owned";
  const outline = taskOutline(task);
  return (
    <article
      onClick={onOpen}
      className={
        "rounded border bg-helios-base px-3 py-2 text-sm " +
        (isExternal ? "border-helios-line/60 opacity-70 cursor-pointer " : "border-helios-line cursor-grab ") +
        (dragging ? "shadow-lg ring-1 ring-asu-gold/60" : !isExternal ? "hover:border-helios-text/30" : "") +
        (selected ? " ring-1 ring-asu-gold" : "")
      }
      style={{ borderLeftWidth: 3, borderLeftColor: outline.borderColor }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {/* Pointer-down must not initiate a drag; stop it before dnd-kit sees it. */}
          {!isExternal && onToggleSelect ? (
            <span
              className="mt-0.5"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <SelectCheckbox
                ariaLabel={`Select task ${task.title}`}
                checked={selected}
                onChange={onToggleSelect}
              />
            </span>
          ) : null}
          <p className={"font-normal " + (isExternal ? "italic text-helios-text/80" : "text-helios-text")}>
            {task.title}
          </p>
        </div>
        {task.priority === "critical" || task.priority === "high" ? (
          <IconFlag
            size={12}
            strokeWidth={1.5}
            className={PRIORITY_TONE[task.priority]}
            aria-label={task.priority}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <TypeBadge type={task.type} />
        {isExternal ? <RelationChip relation={relation} /> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-helios-dim">
        <TaskSubteamChips task={task} />
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <IconUserCircle size={12} strokeWidth={1.5} />
          {task.owner?.name ?? "Unassigned"}
        </span>
      </div>
      {task.due_date ? (
        <p className="mt-1.5 text-xs text-helios-dim tabular-nums">
          Due {task.due_date}
        </p>
      ) : null}
    </article>
  );
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
