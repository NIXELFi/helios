"use client";

import type { CalendarEvent, Milestone, Subteam, TaskColorProperty, TaskRow } from "@helios/pm-ui";
import { STATUS_DOT, TASK_COLOR_PROPERTY_LABEL } from "@helios/pm-ui";
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
  IconArrowRight,
  IconCalendarEvent,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconFlag2,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  addDays,
  addMonths,
  addYears,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  max as maxDate,
  min as minDate,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { EventDialog } from "@pm/components/EventDialog";
import { MilestoneDialog } from "@pm/components/MilestoneDialog";
import { TaskPeekCard } from "@pm/components/TaskPeekCard";
import { TaskFilterBar } from "@pm/components/TaskFilterBar";
import { ViewHeader } from "@pm/components/ViewHeader";
import { Select } from "@pm/components/ui/Select";
import {
  CALENDAR_BODY_PROPS,
  CALENDAR_BORDER_PROPS,
  calendarMarkerColors,
  recallCalendarSettings,
  rememberCalendarSettings,
  type CalendarBorderProperty,
} from "@pm/lib/calendarSettings";
import {
  EMPTY_FILTERS,
  applyHardFilters,
  applySort,
  hasScopeFilters,
  isManufacturingType,
  taskMatchesScopeFilters,
  type TaskFilters,
  type TaskSort,
} from "@pm/lib/filters";
import {
  scopeTasksToSubteam,
  selectIsAdmin,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";
import { useScrollMemory } from "@pm/lib/useScrollMemory";

const FALLBACK_COLOR = "#6B7280";

type CalendarMode = "week" | "month" | "year";

// Stable empty map reused when events are hidden (#25) so gridProps identity is
// not churned every render.
const EMPTY_EVENTS_BY_DATE = new Map<string, CalendarEvent[]>();

// Expand events (incl. recurring) into a date-keyed map within [rangeStart,
// rangeEnd]. Occurrences reference the original event object so editing one
// edits the series. Dense frequencies fast-forward to the window; a guard caps
// the loop defensively.
function expandEventsByDate(
  events: ReadonlyArray<CalendarEvent>,
  rangeStart: Date,
  rangeEnd: Date,
): Map<string, CalendarEvent[]> {
  const m = new Map<string, CalendarEvent[]>();
  const push = (key: string, e: CalendarEvent) => {
    const arr = m.get(key) ?? [];
    arr.push(e);
    m.set(key, arr);
  };
  for (const e of events) {
    const start = parseISO(e.date);
    const rec = e.recurrence ?? "none";
    if (rec === "none") {
      if (!isBefore(start, rangeStart) && !isBefore(rangeEnd, start)) push(e.date, e);
      continue;
    }
    const seriesEnd = e.recurrence_end
      ? minDate([parseISO(e.recurrence_end), rangeEnd])
      : rangeEnd;
    let cur = start;
    // Fast-forward dense frequencies to the first occurrence on/after rangeStart.
    if (isBefore(cur, rangeStart)) {
      if (rec === "daily") {
        cur = addDays(cur, differenceInCalendarDays(rangeStart, cur));
      } else if (rec === "weekly") {
        cur = addDays(cur, Math.floor(differenceInCalendarDays(rangeStart, cur) / 7) * 7);
      }
      // monthly: the loop below advances month-by-month (cheap enough).
    }
    let guard = 0;
    while (!isBefore(seriesEnd, cur) && guard < 800) {
      if (!isBefore(cur, rangeStart)) push(format(cur, "yyyy-MM-dd"), e);
      cur =
        rec === "daily" ? addDays(cur, 1) : rec === "weekly" ? addDays(cur, 7) : addMonths(cur, 1);
      guard++;
    }
  }
  return m;
}

export interface CalendarViewClientProps {
  teamSlug?: string | null;
  manufacturingOnly?: boolean;
}

interface DaySpan {
  start: Date;
  end: Date;
}

export function CalendarViewClient({
  teamSlug = null,
  manufacturingOnly = false,
}: CalendarViewClientProps) {
  const scrollMemRef = useScrollMemory(
    `calendar${manufacturingOnly ? "-mfg" : ""}:${teamSlug ?? "__project__"}`,
  );
  const tasks = usePmStore((s) => s.tasks);
  const milestones = usePmStore((s) => s.milestones);
  const events = usePmStore((s) => s.events);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const projectId = usePmStore((s) => s.projectId);
  const deps = usePmStore((s) => s.dependencies);
  const addTask = usePmStore((s) => s.addTask);
  const updateTask = usePmStore((s) => s.updateTask);
  const selectTask = usePmStore((s) => s.selectTask);
  const addEvent = usePmStore((s) => s.addEvent);
  const updateEvent = usePmStore((s) => s.updateEvent);
  const deleteEvent = usePmStore((s) => s.deleteEvent);
  const addMilestone = usePmStore((s) => s.addMilestone);
  const updateMilestone = usePmStore((s) => s.updateMilestone);
  const deleteMilestone = usePmStore((s) => s.deleteMilestone);
  // Milestone create/edit/delete is admin-only (matches the Gantt view).
  const isAdmin = usePmStore(selectIsAdmin);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;

  // --- Scope to team (owned + cross-team) ------------------------------------
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

  const baseTasks = useMemo(() => {
    const rows = scopedRows.map((r) => r.task);
    return manufacturingOnly ? rows.filter((t) => isManufacturingType(t.type)) : rows;
  }, [scopedRows, manufacturingOnly]);

  // --- Filters + sort --------------------------------------------------------
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<TaskSort>({ key: "due_date", dir: "asc" });

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

  const filtersActive =
    filters.status.length > 0 ||
    filters.subteamIds.length > 0 ||
    filters.types.length > 0 ||
    filters.ownerIds.length > 0 ||
    filters.dueFrom !== null ||
    filters.dueTo !== null ||
    filters.search.length > 0;

  // --- Date buckets ----------------------------------------------------------
  const startByDate = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of filteredTasks) {
      if (!t.start_date) continue;
      const arr = m.get(t.start_date) ?? [];
      arr.push(t);
      m.set(t.start_date, arr);
    }
    for (const [, arr] of m) applySort(arr, sort).forEach((x, i) => (arr[i] = x));
    return m;
  }, [filteredTasks, sort]);

  const dueByDate = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of filteredTasks) {
      if (!t.due_date) continue;
      const arr = m.get(t.due_date) ?? [];
      arr.push(t);
      m.set(t.due_date, arr);
    }
    for (const [, arr] of m) applySort(arr, sort).forEach((x, i) => (arr[i] = x));
    return m;
  }, [filteredTasks, sort]);

  const filteredEvents = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return events.filter((e) => {
      if (q) {
        const inTitle = e.title.toLowerCase().includes(q);
        const inTags = e.type_tags.some((t) => t.toLowerCase().includes(q));
        if (!inTitle && !inTags) return false;
      }
      if (filters.subteamIds.length > 0) {
        if (!e.all_subteams && !e.subteam_ids.some((id) => filters.subteamIds.includes(id))) {
          return false;
        }
      }
      return true;
    });
  }, [events, filters.search, filters.subteamIds]);

  const milestonesByDate = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of milestones) {
      const arr = m.get(ms.target_date) ?? [];
      arr.push(ms);
      m.set(ms.target_date, arr);
    }
    return m;
  }, [milestones]);

  // --- View state ------------------------------------------------------------
  const [mode, setMode] = useState<CalendarMode>("month");
  // Show/hide calendar events (#25) and the collapsible milestones menu (#21).
  const [showEvents, setShowEvents] = useState(true);
  const [milestonesMenuOpen, setMilestonesMenuOpen] = useState(false);

  // Per-mode, per-scope body/border color settings (#22). The active mode's
  // choice drives both the week/month chips and the year squares.
  const [calColors, setCalColors] = useState(() =>
    recallCalendarSettings(teamSlug, currentTeam === null),
  );
  useEffect(() => {
    rememberCalendarSettings(teamSlug, calColors);
  }, [teamSlug, calColors]);

  const seedAnchor = useMemo(() => {
    const candidates: string[] = [];
    for (const t of baseTasks) if (t.due_date) candidates.push(t.due_date);
    for (const m of milestones) candidates.push(m.target_date);
    candidates.sort();
    return candidates[0] ? parseISO(candidates[0]) : new Date();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [anchor, setAnchor] = useState<Date>(seedAnchor);

  // Events expanded into per-date occurrences (#24). Recurring events repeat from
  // their start date through recurrence_end, bounded to a window around the
  // anchor so occurrence counts stay small. Each occurrence references the
  // ORIGINAL event, so clicking one edits the whole series (its real start date).
  const eventsByDate = useMemo(
    () => expandEventsByDate(filteredEvents, addYears(anchor, -1), addYears(anchor, 1)),
    [filteredEvents, anchor],
  );

  // --- Selection + peek ------------------------------------------------------
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ taskId: string; x: number; y: number } | null>(null);

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks],
  );
  const peekTask = useMemo(
    () => (peek ? tasks.find((t) => t.id === peek.taskId) ?? null : null),
    [peek, tasks],
  );

  const selectedSpan: DaySpan | null = useMemo(() => {
    if (!selectedTask) return null;
    const s = selectedTask.start_date ?? selectedTask.due_date;
    const e = selectedTask.due_date ?? selectedTask.start_date;
    if (!s || !e) return null;
    const a = parseISO(s);
    const b = parseISO(e);
    return { start: a < b ? a : b, end: a < b ? b : a };
  }, [selectedTask]);

  // Escape clears selection, peek, and any open menus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedTaskId(null);
        setPeek(null);
        setCreateMenu(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleChipClick(task: TaskRow, e: React.MouseEvent) {
    if (selectedTaskId === task.id) {
      setSelectedTaskId(null);
      setPeek(null);
      return;
    }
    setSelectedTaskId(task.id);
    setPeek({ taskId: task.id, x: e.clientX, y: e.clientY });
  }

  // --- Drag to reschedule ----------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [activeDrag, setActiveDrag] = useState<{ taskId: string; kind: "start" | "due" } | null>(null);

  function handleDragStart(e: DragStartEvent) {
    const [taskId = "", kind = "due"] = String(e.active.id).split(":");
    setActiveDrag({ taskId, kind: kind as "start" | "due" });
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    if (!e.over) return;
    const [taskId = "", kind = "due"] = String(e.active.id).split(":");
    const dateKey = String(e.over.id);
    const relation = relationByTaskId.get(taskId) ?? "owned";
    if (relation !== "owned") return;
    updateTask(taskId, kind === "start" ? { start_date: dateKey } : { due_date: dateKey });
  }

  const activeDragTask = activeDrag ? tasks.find((t) => t.id === activeDrag.taskId) ?? null : null;

  // --- Create flow + event dialog --------------------------------------------
  const [createMenu, setCreateMenu] = useState<{ dateKey: string; x: number; y: number } | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskPrefill, setTaskPrefill] = useState<{ start?: string; due?: string }>({});
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [eventPrefillDate, setEventPrefillDate] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  // Milestone edit dialog (admin only). Reached from the countdown strip cards.
  const [milestoneDialogOpen, setMilestoneDialogOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);

  function openEditMilestone(m: Milestone) {
    setEditingMilestone(m);
    setMilestoneDialogOpen(true);
  }

  function openCreateMenu(dateKey: string, e: React.MouseEvent) {
    setCreateMenu({ dateKey, x: e.clientX, y: e.clientY });
  }

  function startAddTask(dateKey: string, kind: "start" | "due") {
    setTaskPrefill(kind === "start" ? { start: dateKey } : { due: dateKey });
    setTaskDialogOpen(true);
    setCreateMenu(null);
  }

  function startAddEvent(dateKey: string) {
    setEditingEvent(null);
    setEventPrefillDate(dateKey);
    setEventDialogOpen(true);
    setCreateMenu(null);
  }

  function openEditEvent(ev: CalendarEvent) {
    setEditingEvent(ev);
    setEventPrefillDate(null);
    setEventDialogOpen(true);
  }

  function shift(direction: -1 | 1) {
    if (mode === "week") setAnchor(addDays(anchor, 7 * direction));
    else if (mode === "month") setAnchor(addMonths(anchor, direction));
    else setAnchor(addYears(anchor, direction));
  }

  const today = new Date();

  const gridProps = {
    today,
    startByDate,
    dueByDate,
    eventsByDate: showEvents ? eventsByDate : EMPTY_EVENTS_BY_DATE,
    milestonesByDate,
    relationByTaskId,
    dimmedById,
    subteams,
    selectedTaskId,
    selectedSpan,
    bodyProperty: calColors[mode].body,
    borderProperty: calColors[mode].border,
    onChipClick: handleChipClick,
    onEventClick: openEditEvent,
    onDayClick: openCreateMenu,
  };

  return (
    <>
      <ViewHeader
        title={
          manufacturingOnly
            ? "Build · Calendar"
            : currentTeam
              ? `${currentTeam.name} · Calendar`
              : "Calendar"
        }
        description={
          manufacturingOnly
            ? "Manufacturing work (parts, assemblies, drawings) on their dates. Click a chip for details, drag to reschedule."
            : "Tasks on their start and due dates; click a chip for details, drag to reschedule, click a day to add."
        }
        actions={
          // Wrap on narrow screens so the toolbar doesn't clip its right-edge buttons.
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={() => setShowEvents((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded border border-helios-line bg-transparent px-2 py-1 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
              title={showEvents ? "Hide events" : "Show events"}
            >
              {showEvents ? <IconEye size={14} strokeWidth={1.5} /> : <IconEyeOff size={14} strokeWidth={1.5} />}
              Events
            </button>
            <button
              type="button"
              onClick={() => setMilestonesMenuOpen((v) => !v)}
              className={
                "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-normal " +
                (milestonesMenuOpen
                  ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
                  : "border-helios-line bg-transparent text-helios-dim hover:bg-helios-base hover:text-helios-text")
              }
              title="Milestones"
            >
              <IconFlag2 size={14} strokeWidth={1.5} />
              Milestones
            </button>
            <SortControl sort={sort} onChange={setSort} />
            <ModeToggle mode={mode} onChange={setMode} />
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Body
              <Select
                size="sm"
                value={calColors[mode].body}
                ariaLabel={`${mode} body color by`}
                className="min-w-[100px]"
                onChange={(v) =>
                  setCalColors((s) => ({ ...s, [mode]: { ...s[mode], body: v as TaskColorProperty } }))
                }
                options={CALENDAR_BODY_PROPS.map((k) => ({ value: k, label: TASK_COLOR_PROPERTY_LABEL[k] }))}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Border
              <Select
                size="sm"
                value={calColors[mode].border}
                ariaLabel={`${mode} border color by`}
                className="min-w-[100px]"
                onChange={(v) =>
                  setCalColors((s) => ({ ...s, [mode]: { ...s[mode], border: v as CalendarBorderProperty } }))
                }
                options={CALENDAR_BORDER_PROPS.map((k) => ({
                  value: k,
                  label: k === "none" ? "None" : TASK_COLOR_PROPERTY_LABEL[k],
                }))}
              />
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => shift(-1)}
                className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
                aria-label={`Previous ${mode}`}
              >
                <IconChevronLeft size={16} strokeWidth={1.5} />
              </button>
              <span className="min-w-[10rem] text-center text-sm font-medium text-helios-text">
                {anchorLabel(anchor, mode)}
              </span>
              <button
                type="button"
                onClick={() => shift(1)}
                className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
                aria-label={`Next ${mode}`}
              >
                <IconChevronRight size={16} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={() => setAnchor(new Date())}
                className="ml-1 rounded border border-helios-line bg-transparent px-2 py-1 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
              >
                Today
              </button>
            </div>
          </div>
        }
      />

      <TaskFilterBar
        filters={filters}
        subteams={subteams}
        users={users}
        active={filtersActive}
        scopedToTeam={currentTeam !== null}
        hideTypes={manufacturingOnly}
        onPatch={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        onClear={() => setFilters(EMPTY_FILTERS)}
      />

      {milestonesMenuOpen ? (
        <MilestonesMenu
          milestones={milestones}
          canEdit={isAdmin}
          onEdit={openEditMilestone}
          onCreate={() => {
            setEditingMilestone(null);
            setMilestoneDialogOpen(true);
          }}
          onDelete={(m) => {
            if (confirm(`Delete milestone "${m.name}"? This cannot be undone.`))
              deleteMilestone(m.id);
          }}
        />
      ) : null}

      <div ref={scrollMemRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        {mode === "year" ? (
          <YearOverview
            anchor={anchor}
            today={today}
            dueByDate={dueByDate}
            milestonesByDate={milestonesByDate}
            body={calColors.year.body}
            border={calColors.year.border}
            onPickMonth={(d) => {
              setAnchor(d);
              setMode("month");
            }}
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {mode === "month" ? (
              <MonthGrid anchor={anchor} {...gridProps} />
            ) : (
              <WeekGrid anchor={anchor} {...gridProps} />
            )}
            <DragOverlay>
              {activeDragTask && activeDrag ? (
                <TaskChipFace task={activeDragTask} kind={activeDrag.kind} dragging />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {createMenu ? (
        <DayCreateMenu
          x={createMenu.x}
          y={createMenu.y}
          dateKey={createMenu.dateKey}
          onAddTask={(kind) => startAddTask(createMenu.dateKey, kind)}
          onAddEvent={() => startAddEvent(createMenu.dateKey)}
          onClose={() => setCreateMenu(null)}
        />
      ) : null}

      {peek && peekTask ? (
        <TaskPeekCard
          task={peekTask}
          x={peek.x}
          y={peek.y}
          onClose={() => setPeek(null)}
          onOpenEditor={() => {
            selectTask(peekTask.id);
            setPeek(null);
          }}
        />
      ) : null}

      <CreateTaskDialog
        open={taskDialogOpen}
        onClose={() => {
          setTaskDialogOpen(false);
          setTaskPrefill({});
        }}
        onCreate={(task) => {
          const finalTask =
            currentTeam && task.subteam_id !== currentTeam.id
              ? { ...task, subteam_id: currentTeam.id, subteam: currentTeam, subsystem_id: null, subsystem: null }
              : task;
          addTask(finalTask);
        }}
        projectId={projectId}
        subteams={subteams}
        subsystems={subsystems}
        users={users}
        defaultSubteamId={currentTeam?.id ?? null}
        defaultStartDate={taskPrefill.start ?? null}
        defaultDueDate={taskPrefill.due ?? null}
      />

      <EventDialog
        open={eventDialogOpen}
        onClose={() => {
          setEventDialogOpen(false);
          setEditingEvent(null);
          setEventPrefillDate(null);
        }}
        onSave={(ev) => {
          if (editingEvent) updateEvent(ev.id, ev);
          else addEvent(ev);
        }}
        onDelete={(ev) => {
          deleteEvent(ev.id);
          setEventDialogOpen(false);
          setEditingEvent(null);
          setEventPrefillDate(null);
        }}
        projectId={projectId}
        subteams={subteams}
        event={editingEvent}
        defaultDate={eventPrefillDate}
      />

      <MilestoneDialog
        open={milestoneDialogOpen}
        onClose={() => {
          setMilestoneDialogOpen(false);
          setEditingMilestone(null);
        }}
        onSave={(m) => {
          if (editingMilestone) updateMilestone(m.id, m);
          else addMilestone(m);
        }}
        onDelete={(m) => {
          deleteMilestone(m.id);
          setMilestoneDialogOpen(false);
          setEditingMilestone(null);
        }}
        projectId={projectId}
        milestone={editingMilestone}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared grid props
// ---------------------------------------------------------------------------

interface GridShared {
  today: Date;
  startByDate: Map<string, TaskRow[]>;
  dueByDate: Map<string, TaskRow[]>;
  eventsByDate: Map<string, CalendarEvent[]>;
  milestonesByDate: Map<string, Milestone[]>;
  relationByTaskId: Map<string, CrossTeamRelation>;
  dimmedById: Set<string>;
  subteams: ReadonlyArray<Subteam>;
  selectedTaskId: string | null;
  selectedSpan: DaySpan | null;
  bodyProperty: TaskColorProperty;
  borderProperty: CalendarBorderProperty;
  onChipClick: (task: TaskRow, e: React.MouseEvent) => void;
  onEventClick: (ev: CalendarEvent) => void;
  onDayClick: (dateKey: string, e: React.MouseEvent) => void;
}

function chunkWeeks(days: Date[]): Date[][] {
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

// Returns [colStart, colEnd] (0-6, inclusive) of the span within a given week,
// or null if the span does not intersect that week.
function spanColumns(week: Date[], span: DaySpan): [number, number] | null {
  const weekStart = week[0];
  const weekEnd = week[week.length - 1];
  if (!weekStart || !weekEnd) return null;
  if (span.end < weekStart || span.start > weekEnd) return null;
  const from = maxDate([span.start, weekStart]);
  const to = minDate([span.end, weekEnd]);
  return [differenceInCalendarDays(from, weekStart), differenceInCalendarDays(to, weekStart)];
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

function MonthGrid({ anchor, ...shared }: { anchor: Date } & GridShared) {
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(endOfMonth(monthStart));
  const weeks = chunkWeeks(eachDayOfInterval({ start: gridStart, end: gridEnd }));

  return (
    <div className="mt-6 overflow-hidden rounded-md border border-helios-line bg-helios-panel">
      <div className="grid grid-cols-7 border-b border-helios-line">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="px-3 py-2 text-center text-[10px] font-medium uppercase tracking-widest text-helios-dim"
          >
            {d}
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <WeekRow
          key={week[0]?.toISOString() ?? wi}
          week={week}
          monthStart={monthStart}
          cellMinH="7rem"
          {...shared}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week grid — one tall week row
// ---------------------------------------------------------------------------

function WeekGrid({ anchor, ...shared }: { anchor: Date } & GridShared) {
  const week = eachDayOfInterval({ start: startOfWeek(anchor), end: endOfWeek(anchor) });

  return (
    <div className="mt-6 overflow-hidden rounded-md border border-helios-line bg-helios-panel">
      <div className="grid grid-cols-7 border-b border-helios-line">
        {week.map((d) => {
          const isToday = isSameDay(d, shared.today);
          return (
            <div key={d.toISOString()} className="border-r border-helios-line px-3 py-2 text-center last:border-r-0">
              <p className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">{format(d, "EEE")}</p>
              <p className={"mt-0.5 text-base font-medium tabular-nums " + (isToday ? "text-asu-maroon" : "text-helios-text")}>
                {format(d, "d")}
              </p>
            </div>
          );
        })}
      </div>
      <WeekRow week={week} monthStart={null} cellMinH="24rem" {...shared} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week row — relative container with the span bar overlaid
// ---------------------------------------------------------------------------

function WeekRow({
  week,
  monthStart,
  cellMinH,
  selectedSpan,
  ...rest
}: {
  week: Date[];
  monthStart: Date | null;
  cellMinH: string;
} & GridShared) {
  const cols = selectedSpan ? spanColumns(week, selectedSpan) : null;
  const passThrough = (i: number) => cols !== null && i >= cols[0] && i <= cols[1];

  return (
    <div className="relative grid grid-cols-7">
      {week.map((day, i) => (
        <DayCell
          key={day.toISOString()}
          day={day}
          monthStart={monthStart}
          cellMinH={cellMinH}
          reserveLane={passThrough(i)}
          showWeekdayNumber={monthStart !== null}
          selectedSpan={selectedSpan}
          {...rest}
        />
      ))}
      {cols ? (
        <SpanBar leftPct={(cols[0] / 7) * 100} widthPct={((cols[1] - cols[0] + 1) / 7) * 100} />
      ) : null}
    </div>
  );
}

function SpanBar({ leftPct, widthPct }: { leftPct: number; widthPct: number }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 h-5 rounded-sm border border-asu-gold/60 bg-asu-gold/20"
      style={{
        left: `calc(${leftPct}% + 0.5rem)`,
        width: `calc(${widthPct}% - 1rem)`,
        top: "1.9rem",
        transformOrigin: "left",
        transform: grown ? "scaleX(1)" : "scaleX(0)",
        opacity: grown ? 1 : 0,
        transition: "transform 320ms ease, opacity 320ms ease",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Day cell
// ---------------------------------------------------------------------------

function DayCell({
  day,
  monthStart,
  cellMinH,
  reserveLane,
  showWeekdayNumber,
  today,
  startByDate,
  dueByDate,
  eventsByDate,
  milestonesByDate,
  relationByTaskId,
  dimmedById,
  subteams,
  selectedTaskId,
  bodyProperty,
  borderProperty,
  onChipClick,
  onEventClick,
  onDayClick,
}: {
  day: Date;
  monthStart: Date | null;
  cellMinH: string;
  reserveLane: boolean;
  showWeekdayNumber: boolean;
} & GridShared) {
  const dateKey = format(day, "yyyy-MM-dd");
  const { setNodeRef, isOver } = useDroppable({ id: dateKey });

  const startTasks = startByDate.get(dateKey) ?? [];
  const dueTasks = dueByDate.get(dateKey) ?? [];
  const dayEvents = eventsByDate.get(dateKey) ?? [];
  const dayMilestones = milestonesByDate.get(dateKey) ?? [];

  const inMonth = monthStart === null || isSameMonth(day, monthStart);
  const isToday = isSameDay(day, today);

  const subteamById = (id: string) => subteams.find((s) => s.id === id) ?? null;

  return (
    <div
      ref={setNodeRef}
      onClick={(e) => onDayClick(dateKey, e)}
      className={
        "group relative flex flex-col items-start gap-1 border-b border-r border-helios-line p-2 text-left transition-colors hover:bg-helios-base/40 " +
        (inMonth ? "" : "bg-helios-base/20 ") +
        (isOver ? "ring-1 ring-inset ring-asu-gold/60 " : "")
      }
      style={{ minHeight: cellMinH }}
    >
      {showWeekdayNumber ? (
        <div className="flex w-full items-center justify-between">
          <span
            className={
              "inline-flex size-5 items-center justify-center rounded-full text-xs font-medium tabular-nums " +
              (isToday ? "bg-asu-maroon text-white" : inMonth ? "text-helios-text" : "text-helios-dim")
            }
          >
            {format(day, "d")}
          </span>
          <IconPlus size={12} strokeWidth={1.5} className="text-helios-dim opacity-0 group-hover:opacity-100" />
        </div>
      ) : (
        <div className="flex w-full items-center justify-end">
          <IconPlus size={12} strokeWidth={1.5} className="text-helios-dim opacity-0 group-hover:opacity-100" />
        </div>
      )}

      <div
        className="flex flex-col gap-1 self-stretch transition-[padding] duration-300"
        style={{ paddingTop: reserveLane ? "1.75rem" : 0 }}
      >
        {dayMilestones.map((m) => (
          <span
            key={m.id}
            className="inline-flex items-center gap-1 truncate rounded bg-asu-gold/15 px-1.5 py-0.5 text-[10px] font-medium text-asu-gold"
            title={m.name}
          >
            <IconFlag2 size={10} strokeWidth={1.5} />
            {m.name}
          </span>
        ))}

        {dayEvents.map((ev) => (
          <EventChip key={ev.id} event={ev} subteamById={subteamById} onClick={onEventClick} />
        ))}

        {startTasks.map((t) => (
          <TaskChip
            key={`${t.id}:start`}
            task={t}
            kind="start"
            relation={relationByTaskId.get(t.id) ?? "owned"}
            dimmed={dimmedById.has(t.id)}
            selected={selectedTaskId === t.id}
            bodyProperty={bodyProperty}
            borderProperty={borderProperty}
            onClick={onChipClick}
          />
        ))}
        {dueTasks.map((t) => (
          <TaskChip
            key={`${t.id}:due`}
            task={t}
            kind="due"
            relation={relationByTaskId.get(t.id) ?? "owned"}
            dimmed={dimmedById.has(t.id)}
            selected={selectedTaskId === t.id}
            bodyProperty={bodyProperty}
            borderProperty={borderProperty}
            onClick={onChipClick}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task chip (draggable)
// ---------------------------------------------------------------------------

function TaskChip({
  task,
  kind,
  relation,
  dimmed,
  selected,
  bodyProperty,
  borderProperty,
  onClick,
}: {
  task: TaskRow;
  kind: "start" | "due";
  relation: CrossTeamRelation;
  dimmed: boolean;
  selected: boolean;
  bodyProperty: TaskColorProperty;
  borderProperty: CalendarBorderProperty;
  onClick: (task: TaskRow, e: React.MouseEvent) => void;
}) {
  const disabled = relation !== "owned";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${task.id}:${kind}`,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onClick(task, e);
      }}
      className={(isDragging ? "opacity-30 " : "") + (dimmed ? "opacity-40 " : "") + (disabled ? "cursor-pointer " : "cursor-grab ")}
    >
      <TaskChipFace
        task={task}
        kind={kind}
        external={relation !== "owned"}
        selected={selected}
        bodyProperty={bodyProperty}
        borderProperty={borderProperty}
      />
    </div>
  );
}

function TaskChipFace({
  task,
  kind,
  external = false,
  selected = false,
  dragging = false,
  bodyProperty = "status",
  borderProperty = "subteam",
}: {
  task: TaskRow;
  kind: "start" | "due";
  external?: boolean;
  selected?: boolean;
  dragging?: boolean;
  bodyProperty?: TaskColorProperty;
  borderProperty?: CalendarBorderProperty;
}) {
  // Body fill + (optional) left-border color resolved from the per-mode color
  // choice, applying the #23 rules. External tasks stay muted/italic.
  const { background, borderColor } = calendarMarkerColors(task, bodyProperty, borderProperty);
  return (
    <span
      className={
        "inline-flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-[11px] font-normal " +
        (external ? "italic text-helios-text/70 " : "text-helios-text ") +
        (selected ? "ring-1 ring-asu-gold/70 " : "") +
        (dragging ? "shadow-lg ring-1 ring-asu-gold/60 " : "")
      }
      title={`${task.title}${external ? ` · ${task.subteam.name}` : ""}`}
      style={{
        backgroundColor: background,
        opacity: external ? 0.7 : 1,
        ...(borderColor
          ? { borderLeftWidth: 4, borderLeftStyle: "solid", borderLeftColor: borderColor }
          : {}),
      }}
    >
      {kind === "start" ? (
        <IconArrowRight size={11} strokeWidth={1.5} className="shrink-0 text-helios-dim" />
      ) : (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[task.status] }} />
      )}
      <span className="truncate">{task.title}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Event chip — visually distinct (dashed, calendar icon, tags)
// ---------------------------------------------------------------------------

function EventChip({
  event,
  subteamById,
  onClick,
}: {
  event: CalendarEvent;
  subteamById: (id: string) => Subteam | null;
  onClick: (ev: CalendarEvent) => void;
}) {
  const teams = event.all_subteams
    ? null
    : event.subteam_ids.map((id) => subteamById(id)).filter((s): s is Subteam => s !== null);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(event);
      }}
      className="inline-flex w-full items-center gap-1.5 truncate rounded border border-dashed border-helios-line bg-helios-base/20 px-1.5 py-0.5 text-left text-[11px] font-normal text-helios-text hover:border-asu-gold/60"
      title={event.title + (event.type_tags.length ? ` · ${event.type_tags.join(", ")}` : "")}
    >
      <IconCalendarEvent size={11} strokeWidth={1.5} className="shrink-0 text-asu-gold" />
      {event.all_subteams ? (
        <span className="shrink-0 text-[9px] font-medium uppercase tracking-widest text-helios-dim">All</span>
      ) : teams && teams.length > 0 ? (
        <span aria-hidden className="flex shrink-0 -space-x-0.5">
          {teams.slice(0, 3).map((s) => (
            <span
              key={s.id}
              className="size-2 rounded-full ring-1 ring-helios-panel"
              style={{ backgroundColor: s.color ?? FALLBACK_COLOR }}
            />
          ))}
        </span>
      ) : null}
      <span className="truncate">{event.title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Day-click create menu
// ---------------------------------------------------------------------------

function DayCreateMenu({
  x,
  y,
  dateKey,
  onAddTask,
  onAddEvent,
  onClose,
}: {
  x: number;
  y: number;
  dateKey: string;
  onAddTask: (kind: "start" | "due") => void;
  onAddEvent: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [taskStep, setTaskStep] = useState(false);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const W = 200;
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1280) - W - 12);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - 160);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 flex flex-col gap-0.5 rounded-md border border-helios-line bg-helios-panel p-1 shadow-lg"
      style={{ left: Math.max(12, left), top: Math.max(12, top), width: W }}
    >
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        {format(parseISO(dateKey), "EEE, MMM d")}
      </div>
      {!taskStep ? (
        <>
          <MenuItem onClick={() => setTaskStep(true)}>Add task…</MenuItem>
          <MenuItem onClick={onAddEvent}>Add event…</MenuItem>
        </>
      ) : (
        <>
          <div className="px-2 py-1 text-[10px] text-helios-dim">Use this date as the task's…</div>
          <MenuItem onClick={() => onAddTask("start")}>Start date</MenuItem>
          <MenuItem onClick={() => onAddTask("due")}>Due date</MenuItem>
        </>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rounded px-2 py-1.5 text-left text-sm font-normal text-helios-text hover:bg-helios-base hover:text-asu-gold"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mode toggle + sort control
// ---------------------------------------------------------------------------

function ModeToggle({ mode, onChange }: { mode: CalendarMode; onChange: (m: CalendarMode) => void }) {
  const opts: Array<{ key: CalendarMode; label: string }> = [
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
    { key: "year", label: "Year" },
  ];
  return (
    <div className="inline-flex rounded-md border border-helios-line bg-helios-panel p-0.5 text-xs font-normal">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={
            "rounded px-2.5 py-1 transition-colors " +
            (mode === o.key ? "bg-helios-base text-helios-text" : "text-helios-dim hover:text-helios-text")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SortControl({ sort, onChange }: { sort: TaskSort; onChange: (s: TaskSort) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Sort</span>
      <Select
        value={sort.key}
        onChange={(v) => onChange({ ...sort, key: v as TaskSort["key"] })}
        ariaLabel="Sort tasks within a day"
        className="min-w-[120px]"
        options={[
          { value: "due_date", label: "Due date" },
          { value: "title", label: "Title" },
          { value: "status", label: "Status" },
          { value: "priority", label: "Priority" },
          { value: "owner", label: "Owner" },
          { value: "subsystem", label: "Subsystem" },
        ]}
      />
      <button
        type="button"
        onClick={() => onChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
        className="rounded border border-helios-line bg-transparent px-2 py-1 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
        aria-label="Toggle sort direction"
      >
        {sort.dir === "asc" ? "↑" : "↓"}
      </button>
    </div>
  );
}

function anchorLabel(anchor: Date, mode: CalendarMode): string {
  if (mode === "month") return format(startOfMonth(anchor), "MMMM yyyy");
  if (mode === "week") {
    const s = startOfWeek(anchor);
    const e = endOfWeek(anchor);
    return `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`;
  }
  const start = competitionYearStart(anchor);
  const end = addMonths(start, 11);
  return `${format(start, "MMM yyyy")} – ${format(end, "MMM yyyy")}`;
}

function competitionYearStart(anchor: Date): Date {
  const m = anchor.getMonth();
  const y = anchor.getFullYear();
  return new Date(m >= 5 ? y : y - 1, 5, 1);
}

// ---------------------------------------------------------------------------
// Countdown strip
// ---------------------------------------------------------------------------

// Collapsible milestones menu (#21): lists every milestone with its description
// and countdown. Create/edit/delete controls render only for admins (chief
// engineer / owner); everyone else gets a read-only list.
function MilestonesMenu({
  milestones,
  canEdit = false,
  onEdit,
  onCreate,
  onDelete,
}: {
  milestones: ReadonlyArray<Milestone>;
  canEdit?: boolean;
  onEdit?: (m: Milestone) => void;
  onCreate?: () => void;
  onDelete?: (m: Milestone) => void;
}) {
  const today = new Date();
  const sorted = [...milestones].sort((a, b) => a.target_date.localeCompare(b.target_date));

  return (
    <div className="border-b border-helios-line bg-helios-panel/40 px-6 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-helios-dim">
          <IconFlag2 size={12} strokeWidth={1.5} /> Milestones · {sorted.length}
        </h3>
        {canEdit && onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-1 rounded border border-helios-line bg-transparent px-2 py-0.5 text-[11px] font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
          >
            <IconPlus size={12} strokeWidth={1.5} /> New milestone
          </button>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-helios-dim">No milestones.</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {sorted.map((m) => {
            const d = parseISO(m.target_date);
            const days = differenceInCalendarDays(d, today);
            const past = days < 0;
            return (
              <li
                key={m.id}
                className="flex items-start gap-2 rounded border border-helios-line bg-helios-base/30 px-3 py-2"
              >
                <IconFlag2 size={12} strokeWidth={1.5} className="mt-0.5 shrink-0 text-asu-gold" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-xs font-medium text-helios-text">{m.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-helios-dim">
                      {format(d, "EEE, MMM d, yyyy")}
                    </span>
                    <span
                      className={
                        "shrink-0 text-[11px] tabular-nums " +
                        (past ? "text-helios-dim" : days <= 14 ? "text-asu-gold" : "text-helios-text")
                      }
                    >
                      {past ? `${Math.abs(days)}d ago` : `in ${days}d`}
                    </span>
                  </div>
                  {m.description ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-helios-dim">{m.description}</p>
                  ) : null}
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {onEdit ? (
                      <button
                        type="button"
                        onClick={() => onEdit(m)}
                        aria-label={`Edit milestone ${m.name}`}
                        title="Edit"
                        className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
                      >
                        <IconPencil size={13} strokeWidth={1.5} />
                      </button>
                    ) : null}
                    {onDelete ? (
                      <button
                        type="button"
                        onClick={() => onDelete(m)}
                        aria-label={`Delete milestone ${m.name}`}
                        title="Delete"
                        className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-red-400"
                      >
                        <IconTrash size={13} strokeWidth={1.5} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Year overview — 12 mini-month thumbnails covering Jun → May
// ---------------------------------------------------------------------------

function YearOverview({
  anchor,
  today,
  dueByDate,
  milestonesByDate,
  body,
  border,
  onPickMonth,
}: {
  anchor: Date;
  today: Date;
  dueByDate: Map<string, TaskRow[]>;
  milestonesByDate: Map<string, Milestone[]>;
  body: TaskColorProperty;
  border: CalendarBorderProperty;
  onPickMonth: (m: Date) => void;
}) {
  const start = competitionYearStart(anchor);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(start, i));

  return (
    <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {months.map((m) => (
        <YearMonth
          key={m.toISOString()}
          monthStart={m}
          today={today}
          dueByDate={dueByDate}
          milestonesByDate={milestonesByDate}
          body={body}
          border={border}
          onPick={() => onPickMonth(m)}
        />
      ))}
    </div>
  );
}

function YearMonth({
  monthStart,
  today,
  dueByDate,
  milestonesByDate,
  body,
  border,
  onPick,
}: {
  monthStart: Date;
  today: Date;
  dueByDate: Map<string, TaskRow[]>;
  milestonesByDate: Map<string, Milestone[]>;
  body: TaskColorProperty;
  border: CalendarBorderProperty;
  onPick: () => void;
}) {
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(endOfMonth(monthStart));
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const monthMilestones = days.flatMap((d) => milestonesByDate.get(format(d, "yyyy-MM-dd")) ?? []);

  const taskCount = days.reduce((sum, d) => {
    if (!isSameMonth(d, monthStart)) return sum;
    return sum + (dueByDate.get(format(d, "yyyy-MM-dd"))?.length ?? 0);
  }, 0);

  return (
    <button
      type="button"
      onClick={onPick}
      className="group rounded-md border border-helios-line bg-helios-panel p-3 text-left transition-colors hover:border-helios-text/30"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-helios-text group-hover:text-asu-gold">
          {format(monthStart, "MMMM yyyy")}
        </h3>
        <span className="text-[10px] font-normal tabular-nums text-helios-dim">
          {taskCount} task{taskCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-px text-[9px] text-helios-dim">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={`${d}-${i}`} className="text-center">{d}</div>
        ))}
        {days.map((d) => {
          const inMonth = isSameMonth(d, monthStart);
          const isToday = isSameDay(d, today);
          const dateKey = format(d, "yyyy-MM-dd");
          const hasMilestone = milestonesByDate.has(dateKey);
          const dayTasks = dueByDate.get(dateKey) ?? [];
          const taskN = dayTasks.length;
          return (
            <div
              key={dateKey}
              className={
                "relative flex aspect-square flex-col items-center justify-center gap-0.5 rounded text-[9px] tabular-nums " +
                (isToday
                  ? "bg-asu-maroon text-white "
                  : hasMilestone
                    ? "bg-asu-gold/15 text-asu-gold "
                    : taskN > 0
                      ? "bg-helios-base/40 text-helios-text "
                      : inMonth
                        ? "text-helios-text/70 "
                        : "text-helios-dim/40 ")
              }
              title={
                hasMilestone
                  ? milestonesByDate.get(dateKey)!.map((m) => m.name).join(", ")
                  : taskN
                    ? `${taskN} task${taskN === 1 ? "" : "s"}`
                    : undefined
              }
            >
              <span className="leading-none">{format(d, "d")}</span>
              {taskN > 0 ? (
                <span className="flex max-w-full flex-wrap justify-center gap-[1.5px] leading-none">
                  {dayTasks.slice(0, 6).map((t, i) => {
                    // Brighter (higher alpha) + slightly larger than the week/month
                    // chips so the year heatmap reads clearly at a glance.
                    const { background, borderColor } = calendarMarkerColors(t, body, border, 0.85);
                    return (
                      <span
                        key={`${t.id}-${i}`}
                        className="size-[5px] rounded-[1.5px]"
                        style={{
                          backgroundColor: background,
                          ...(borderColor ? { boxShadow: `0 0 0 0.5px ${borderColor}` } : {}),
                        }}
                      />
                    );
                  })}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {monthMilestones.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {monthMilestones.slice(0, 3).map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1 rounded bg-asu-gold/15 px-1.5 py-0 text-[9px] font-medium uppercase tracking-widest text-asu-gold"
              title={m.name}
            >
              <IconFlag2 size={8} strokeWidth={1.5} />
              {m.name}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}
