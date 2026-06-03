"use client";

import type {
  Milestone,
  MilestoneType,
  Subteam,
  TaskColorProperty,
  TaskRow,
} from "@helios/pm-ui";
import {
  TASK_COLOR_PROPERTY_LABEL,
  colorForTask,
  computeCriticalPath,
  hexToRgba,
} from "@helios/pm-ui";
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isFirstDayOfMonth,
  parseISO,
  startOfDay,
} from "date-fns";
import {
  IconEdit,
  IconEye,
  IconEyeOff,
  IconMinus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { ViewHeader } from "@pm/components/ViewHeader";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { GanttLegend } from "@pm/components/GanttLegend";
import { MilestoneDialog } from "@pm/components/MilestoneDialog";
import { TaskPeekCard } from "@pm/components/TaskPeekCard";
import { Select } from "@pm/components/ui/Select";
import { isManufacturingType } from "@pm/lib/filters";
import {
  recallGanttSettings,
  rememberGanttSettings,
} from "@pm/lib/ganttSettings";
import {
  scopeTasksToSubteam,
  selectIsAdmin,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

type GanttSort = "criticality" | "upcoming" | "subteam_asc" | "subteam_desc";

const SORT_LABEL: Record<GanttSort, string> = {
  criticality: "Most critical",
  upcoming: "Upcoming deadline",
  subteam_asc: "Subteam A–Z",
  subteam_desc: "Subteam Z–A",
};

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function criticalityScore(t: TaskRow, critical: Set<string>): number {
  return (critical.has(t.id) ? 100 : 0) + (PRIORITY_RANK[t.priority] ?? 0);
}

// Orders tasks within each subteam group (top to bottom).
function taskComparator(
  sort: GanttSort,
  critical: Set<string>,
): (a: TaskRow, b: TaskRow) => number {
  if (sort === "upcoming") {
    return (a, b) => (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31");
  }
  return (a, b) => criticalityScore(b, critical) - criticalityScore(a, critical);
}

const MILESTONE_TYPE_LABEL: Record<MilestoneType, string> = {
  design_review: "Design review",
  integration: "Integration",
  validation: "Validation",
  gate: "Gate",
  comp_event: "Competition",
};

// Default zoom levels — overridden by component state at runtime.
const DEFAULT_DAY_WIDTH = 14;
const DEFAULT_ROW_HEIGHT = 32;
const DAY_BOUNDS = { min: 4, max: 48 } as const;
const ROW_BOUNDS = { min: 20, max: 60 } as const;
const SUBSYSTEM_HEADER_HEIGHT = 24;

// Default bars read as translucent "glass": the resolved property color is laid
// down at this alpha behind a backdrop blur, with the light text color on top.
const GLASS_ALPHA = 0.18;

// The four task properties a bar's background / outline can be colored by.
const COLOR_PROPERTY_OPTIONS: Array<{ value: TaskColorProperty; label: string }> = (
  ["status", "priority", "subteam", "owner"] as TaskColorProperty[]
).map((p) => ({ value: p, label: TASK_COLOR_PROPERTY_LABEL[p] }));

// Bar/label font scales with row height so text stays proportional as rows grow
// or shrink; clamped to stay legible at the minimum row height.
function barFontPx(rowHeight: number): number {
  return Math.min(16, Math.max(9, Math.round(rowHeight * 0.34)));
}

interface BarLayout {
  task: TaskRow;
  relation: CrossTeamRelation;
  rowIndex: number;
  startDayIndex: number;
  widthDays: number;
}

export interface GanttViewClientProps {
  teamSlug?: string | null;
  manufacturingOnly?: boolean;
}

export function GanttViewClient({ teamSlug = null, manufacturingOnly = false }: GanttViewClientProps) {
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const milestones = usePmStore((s) => s.milestones);
  const deps = usePmStore((s) => s.dependencies);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const projectId = usePmStore((s) => s.projectId);
  const selectTask = usePmStore((s) => s.selectTask);
  const addTask = usePmStore((s) => s.addTask);
  const addMilestone = usePmStore((s) => s.addMilestone);
  const updateMilestone = usePmStore((s) => s.updateMilestone);
  const deleteMilestone = usePmStore((s) => s.deleteMilestone);
  const isAdmin = usePmStore(selectIsAdmin);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;

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

  const visibleTasks = useMemo(() => {
    const rows = scopedRows.map((r) => r.task);
    return manufacturingOnly ? rows.filter((t) => isManufacturingType(t.type)) : rows;
  }, [scopedRows, manufacturingOnly]);

  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [sort, setSort] = useState<GanttSort>("criticality");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hiddenCursors, setHiddenCursors] = useState<Set<string>>(new Set());
  const [cursorMenuOpen, setCursorMenuOpen] = useState(false);
  // Milestone create/edit dialog (admin only). `null` milestone = create mode.
  const [milestoneDialogOpen, setMilestoneDialogOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [dayWidth, setDayWidth] = useState(DEFAULT_DAY_WIDTH);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const barHeight = Math.max(10, rowHeight - 14);
  const barFont = barFontPx(rowHeight);
  const critical = useMemo(() => computeCriticalPath(tasks, deps), [tasks, deps]);

  // Task-detail peek popup (same pattern as CalendarViewClient): clicking a bar
  // opens a TaskPeekCard anchored at the click; "Open editor" escalates to the
  // full editor via selectTask.
  const [peek, setPeek] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const peekTask = useMemo(
    () => (peek ? tasks.find((t) => t.id === peek.taskId) ?? null : null),
    [peek, tasks],
  );

  // Color-by-property settings, persisted per-scope (see ganttSettings.ts).
  const [colorSettings, setColorSettings] = useState(() => recallGanttSettings(teamSlug));
  const { bgProperty, outlineProperty } = colorSettings;
  useEffect(() => {
    rememberGanttSettings(teamSlug, colorSettings);
  }, [teamSlug, colorSettings]);

  function toggleCursor(id: string) {
    setHiddenCursors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bumpDayWidth(delta: number) {
    setDayWidth((v) => Math.min(DAY_BOUNDS.max, Math.max(DAY_BOUNDS.min, v + delta)));
  }
  function bumpRowHeight(delta: number) {
    setRowHeight((v) => Math.min(ROW_BOUNDS.max, Math.max(ROW_BOUNDS.min, v + delta)));
  }

  const layout = useMemo(() => {
    const dates: Date[] = [];
    for (const t of visibleTasks) {
      if (t.start_date) dates.push(parseISO(t.start_date));
      if (t.due_date) dates.push(parseISO(t.due_date));
    }
    for (const m of milestones) dates.push(parseISO(m.target_date));
    if (dates.length === 0) {
      return null;
    }
    let min = dates[0]!;
    let max = dates[0]!;
    for (const d of dates) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const rangeStart = startOfDay(addDays(min, -2));
    const rangeEnd = startOfDay(addDays(max, 2));
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });

    // Group by subteam (in current scope), preserving the global subteam order.
    const teamOrder = subteams.map((s) => s.id);
    const groups = new Map<string, TaskRow[]>();
    for (const id of teamOrder) groups.set(id, []);
    for (const t of visibleTasks) {
      if (!t.start_date || !t.due_date) continue;
      const arr = groups.get(t.subteam_id) ?? [];
      arr.push(t);
      groups.set(t.subteam_id, arr);
    }

    const compare = taskComparator(sort, critical);
    const groupOrder = [...subteams];
    if (sort === "subteam_asc") groupOrder.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "subteam_desc") groupOrder.sort((a, b) => b.name.localeCompare(a.name));

    const orderedGroups: Array<{ subteam: Subteam; tasks: TaskRow[] }> = [];
    for (const s of groupOrder) {
      const ts = groups.get(s.id) ?? [];
      if (ts.length > 0) orderedGroups.push({ subteam: s, tasks: [...ts].sort(compare) });
    }

    const bars: BarLayout[] = [];
    let rowIndex = 0;
    const groupSpans: Array<{ subteam: Subteam; headerRow: number; taskRows: number }> = [];

    for (const g of orderedGroups) {
      groupSpans.push({ subteam: g.subteam, headerRow: rowIndex, taskRows: g.tasks.length });
      rowIndex += 1;
      for (const t of g.tasks) {
        const start = parseISO(t.start_date!);
        const end = parseISO(t.due_date!);
        const startDayIndex = differenceInCalendarDays(start, rangeStart);
        const widthDays = Math.max(1, differenceInCalendarDays(end, start) + 1);
        const relation = relationByTaskId.get(t.id) ?? "owned";
        bars.push({ task: t, relation, rowIndex, startDayIndex, widthDays });
        rowIndex += 1;
      }
    }
    const totalRows = rowIndex;

    return { days, totalDays: days.length, totalRows, bars, groupSpans, rangeStart };
  }, [visibleTasks, milestones, subteams, relationByTaskId, sort, critical]);

  if (!layout) {
    return (
      <>
        <ViewHeader
          title={currentTeam ? `${currentTeam.name} · Gantt` : "Gantt"}
          description="No dated tasks to chart in this scope."
        />
      </>
    );
  }

  const { days, totalDays, totalRows, bars, groupSpans, rangeStart } = layout;
  const timelineWidth = totalDays * dayWidth;
  const headerHeight = 36;
  const barByTaskId = new Map<string, BarLayout>(bars.map((b) => [b.task.id, b]));

  return (
    <>
      <ViewHeader
        title={
          manufacturingOnly
            ? "Build · Gantt"
            : currentTeam
              ? `${currentTeam.name} · Gantt`
              : "Gantt"
        }
        description={
          `${bars.length} bars · ${groupSpans.length} subteam${groupSpans.length === 1 ? "" : "s"} · ` +
          "ctrl + scroll to zoom time · ctrl + shift + scroll to zoom rows"
        }
        actions={
          // Wrap on narrow screens — this toolbar packs 8 controls, and a single
          // non-wrapping row clipped the "New task" button on smaller windows.
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Sort
              <Select
                size="sm"
                value={sort}
                ariaLabel="Sort"
                className="min-w-[130px]"
                onChange={(v) => setSort(v as GanttSort)}
                options={(Object.keys(SORT_LABEL) as GanttSort[]).map((k) => ({
                  value: k,
                  label: SORT_LABEL[k],
                }))}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Background
              <Select
                size="sm"
                value={bgProperty}
                ariaLabel="Color bars by"
                className="min-w-[110px]"
                onChange={(v) =>
                  setColorSettings((s) => ({ ...s, bgProperty: v as TaskColorProperty }))
                }
                options={COLOR_PROPERTY_OPTIONS}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Outline
              <Select
                size="sm"
                value={outlineProperty}
                ariaLabel="Outline bars by"
                className="min-w-[110px]"
                onChange={(v) =>
                  setColorSettings((s) => ({ ...s, outlineProperty: v as TaskColorProperty }))
                }
                options={COLOR_PROPERTY_OPTIONS}
              />
            </label>
            <ZoomGroup
              label="Time"
              value={dayWidth}
              suffix="px/day"
              onMinus={() => bumpDayWidth(-2)}
              onPlus={() => bumpDayWidth(2)}
              minusDisabled={dayWidth <= DAY_BOUNDS.min}
              plusDisabled={dayWidth >= DAY_BOUNDS.max}
            />
            <ZoomGroup
              label="Rows"
              value={rowHeight}
              suffix="px"
              onMinus={() => bumpRowHeight(-2)}
              onPlus={() => bumpRowHeight(2)}
              minusDisabled={rowHeight <= ROW_BOUNDS.min}
              plusDisabled={rowHeight >= ROW_BOUNDS.max}
            />
            <label className="inline-flex items-center gap-2 text-xs font-normal text-helios-dim">
              <input
                type="checkbox"
                checked={showCriticalOnly}
                onChange={(e) => setShowCriticalOnly(e.target.checked)}
                className="size-3 accent-asu-gold"
              />
              Dim non-critical
            </label>
            <CursorMenu
              open={cursorMenuOpen}
              onToggleOpen={() => setCursorMenuOpen((v) => !v)}
              milestones={milestones}
              hidden={hiddenCursors}
              onToggle={toggleCursor}
              isAdmin={isAdmin}
              onEditMilestone={(m) => {
                setEditingMilestone(m);
                setMilestoneDialogOpen(true);
                setCursorMenuOpen(false);
              }}
              onDeleteMilestone={(m) => {
                if (confirm(`Delete milestone "${m.name}"? This cannot be undone.`)) {
                  deleteMilestone(m.id);
                }
              }}
              onNewMilestone={() => {
                setEditingMilestone(null);
                setMilestoneDialogOpen(true);
                setCursorMenuOpen(false);
              }}
            />
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90"
            >
              <IconPlus size={16} strokeWidth={1.5} />
              New task
            </button>
          </div>
        }
      />

      <div className="flex items-center gap-4 border-b border-helios-line bg-helios-panel/40 px-4 py-1.5">
        <GanttLegend
          bgProperty={bgProperty}
          outlineProperty={outlineProperty}
          subteams={subteams}
          users={users}
        />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-helios-dim">
          <span aria-hidden className="inline-block h-3 w-0.5 bg-asu-maroon" />
          Today
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-helios-dim">
          <span aria-hidden className="inline-block h-3 w-0.5 bg-asu-gold/60" />
          Milestone
        </span>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto"
        onWheel={(e) => {
          if (!e.ctrlKey) return; // Without ctrl, let normal scroll/pan happen
          e.preventDefault();
          const dir = e.deltaY < 0 ? 1 : -1; // scroll up = zoom in
          if (e.shiftKey) bumpRowHeight(dir * 2);
          else bumpDayWidth(dir * 2);
        }}
      >
        <div className="flex">
          <div className="sticky left-0 z-30 w-56 shrink-0 border-r border-helios-line bg-helios-panel">
            <div
              className="border-b border-helios-line px-3 text-[10px] font-medium uppercase tracking-widest text-helios-dim"
              style={{ height: headerHeight, lineHeight: `${headerHeight}px` }}
            >
              Subteam · Task
            </div>
            {groupSpans.map((g) => (
              <div key={g.subteam.id}>
                <div
                  className="flex items-center gap-2 border-b border-helios-line bg-helios-base/40 px-3 text-xs font-medium text-helios-text"
                  style={{ height: SUBSYSTEM_HEADER_HEIGHT }}
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: g.subteam.color ?? "#6B7280" }}
                  />
                  {g.subteam.name}
                </div>
                {Array.from({ length: g.taskRows }).map((_, i) => {
                  const bar = bars.find((b) => b.rowIndex === g.headerRow + 1 + i);
                  const ext = bar && bar.relation !== "owned";
                  return (
                    <div
                      key={i}
                      className={
                        "truncate border-b border-helios-line/60 px-6 font-normal " +
                        (ext ? "italic text-helios-text/70" : "text-helios-text")
                      }
                      style={{ height: rowHeight, lineHeight: `${rowHeight}px`, fontSize: barFont }}
                      title={bar?.task.title}
                    >
                      {bar?.task.title}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div
            className="relative bg-helios-panel/40"
            style={{ width: timelineWidth, minHeight: totalRows * rowHeight + headerHeight }}
          >
            <div
              className="sticky top-0 z-10 flex border-b border-helios-line bg-helios-panel"
              style={{ height: headerHeight }}
            >
              {days.map((d, i) => {
                const isMonthStart = isFirstDayOfMonth(d) || i === 0;
                return (
                  <div
                    key={i}
                    className="relative shrink-0 border-r border-helios-line/40"
                    style={{ width: dayWidth, height: headerHeight }}
                  >
                    {isMonthStart ? (
                      <span className="absolute left-1 top-1 whitespace-nowrap text-[10px] font-medium uppercase tracking-widest text-helios-dim">
                        {format(d, "MMM")}
                      </span>
                    ) : null}
                    <span
                      className={
                        "absolute bottom-1 left-0 right-0 text-center text-[9px] tabular-nums " +
                        (d.getDay() === 0 || d.getDay() === 6 ? "text-helios-dim/40" : "text-helios-dim")
                      }
                    >
                      {format(d, "d")}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="absolute left-0 right-0" style={{ top: headerHeight }}>
              {groupSpans.map((g) => (
                <div key={g.subteam.id}>
                  <div
                    className="border-b border-helios-line bg-helios-base/40"
                    style={{ height: SUBSYSTEM_HEADER_HEIGHT }}
                  />
                  {Array.from({ length: g.taskRows }).map((_, i) => (
                    <div
                      key={i}
                      className="border-b border-helios-line/40"
                      style={{ height: rowHeight }}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* Weekend shading */}
            <div className="pointer-events-none absolute inset-0" style={{ top: headerHeight }}>
              {days.map((d, i) => {
                if (d.getDay() !== 0 && d.getDay() !== 6) return null;
                return (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 bg-helios-base/20"
                    style={{ left: i * dayWidth, width: dayWidth }}
                  />
                );
              })}
            </div>

            {/* Today + milestone cursors. Offset to start BELOW the sticky dates
                header so no cursor line/label paints up into the header band
                (the header is opaque + z-10 and would otherwise occlude them).
                z-20 keeps the lines/labels above the bars; the sticky left task
                column is z-30 so it still occludes cursors on horizontal scroll. */}
            <div
              className="pointer-events-none absolute left-0 right-0 z-20"
              style={{ top: headerHeight, bottom: 0 }}
            >
              {(() => {
                const today = startOfDay(new Date());
                const tx = differenceInCalendarDays(today, rangeStart) * dayWidth;
                if (tx < 0 || tx > timelineWidth) return null;
                return (
                  <div
                    className="absolute top-0 bottom-0 border-l-2 border-asu-maroon"
                    style={{ left: tx }}
                    title={`Today · ${format(today, "MMM d, yyyy")}`}
                  >
                    <span className="absolute top-1 left-1 z-20 whitespace-nowrap rounded bg-asu-maroon/20 px-1 py-0.5 text-[10px] font-medium text-asu-maroon">
                      Today
                    </span>
                  </div>
                );
              })()}
              {milestones.map((m) => {
                if (hiddenCursors.has(m.id)) return null;
                const day = parseISO(m.target_date);
                const x = differenceInCalendarDays(day, rangeStart) * dayWidth;
                if (x < 0 || x > timelineWidth) return null;
                const days = differenceInCalendarDays(startOfDay(day), startOfDay(new Date()));
                const countdown =
                  days === 0 ? "today" : days > 0 ? `${days}d out` : `${Math.abs(days)}d ago`;
                // Admins can click the on-chart label chip to edit the milestone
                // (the cursor container is pointer-events-none, so the button
                // re-enables pointer events for itself). Non-admins get the same
                // chip as a static, non-interactive label.
                const chipBody = (
                  <>
                    <span>{m.name}</span>
                    <span className="font-normal text-asu-gold/70">
                      {MILESTONE_TYPE_LABEL[m.type]} · {countdown}
                    </span>
                  </>
                );
                return (
                  <div
                    key={m.id}
                    className="absolute top-0 bottom-0 border-l border-asu-gold/60"
                    style={{ left: x }}
                    title={`${MILESTONE_TYPE_LABEL[m.type]}: ${m.name} · ${format(day, "MMM d, yyyy")} · ${countdown}`}
                  >
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMilestone(m);
                          setMilestoneDialogOpen(true);
                        }}
                        title={`Edit milestone "${m.name}"`}
                        className="pointer-events-auto absolute top-1 left-1 z-20 flex cursor-pointer flex-col whitespace-nowrap rounded bg-asu-gold/15 px-1 py-0.5 text-left text-[10px] font-medium text-asu-gold transition-colors hover:bg-asu-gold/30 hover:ring-1 hover:ring-asu-gold/50"
                      >
                        {chipBody}
                      </button>
                    ) : (
                      <span className="absolute top-1 left-1 z-20 flex flex-col whitespace-nowrap rounded bg-asu-gold/15 px-1 py-0.5 text-[10px] font-medium text-asu-gold">
                        {chipBody}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="absolute inset-0" style={{ top: headerHeight }}>
              {bars.map((b) => {
                const isCritical = critical.has(b.task.id);
                const isExternal = b.relation !== "owned";
                const dim = showCriticalOnly && !isCritical;
                const top = b.rowIndex * rowHeight + (rowHeight - barHeight) / 2;
                // Glass background: resolved bg-property color at low alpha behind
                // a backdrop blur, with light text on top.
                const bgColor = hexToRgba(colorForTask(b.task, bgProperty), GLASS_ALPHA);
                // Outline ALWAYS reflects the chosen outline property so the
                // legend's "Outline" row stays truthful. The critical-path /
                // cross-team signal moves to a subtle non-outline cue below
                // (corner glyph + title suffix) so it no longer hides the color.
                const border = `2px solid ${colorForTask(b.task, outlineProperty)}`;
                const titleSuffix =
                  (isCritical ? " · critical path" : "") +
                  (isExternal ? " · cross-team" : "");
                return (
                  <button
                    key={b.task.id}
                    type="button"
                    onClick={(e) =>
                      setPeek({ taskId: b.task.id, x: e.clientX, y: e.clientY })
                    }
                    className={
                      "absolute cursor-pointer overflow-hidden rounded text-left font-medium text-helios-text shadow-sm backdrop-blur-sm hover:brightness-110 focus:outline-none focus:ring-1 focus:ring-asu-gold " +
                      (dim ? "opacity-25" : isExternal ? "opacity-55" : "opacity-100")
                    }
                    style={{
                      left: b.startDayIndex * dayWidth,
                      width: b.widthDays * dayWidth - 2,
                      top,
                      height: barHeight,
                      fontSize: barFont,
                      backgroundColor: bgColor,
                      border,
                    }}
                    title={`${b.task.title} · ${b.task.start_date} → ${b.task.due_date}${titleSuffix}`}
                  >
                    <span className="block truncate px-1.5 leading-tight">
                      {b.task.title}
                    </span>
                    {isCritical ? (
                      <span
                        aria-hidden
                        title="On critical path"
                        className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-asu-gold shadow-sm"
                      />
                    ) : isExternal ? (
                      <span
                        aria-hidden
                        title="Cross-team dependency"
                        className="absolute right-0.5 top-0 leading-none text-asu-gold/80"
                        style={{ fontSize: Math.max(8, Math.round(barFont * 0.7)) }}
                      >
                        ↗
                      </span>
                    ) : null}
                  </button>
                );
              })}

              <svg
                className="pointer-events-none absolute inset-0"
                width={timelineWidth}
                height={totalRows * rowHeight}
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#9097A0" />
                  </marker>
                </defs>
                {deps.map((d) => {
                  const pred = barByTaskId.get(d.predecessor_id);
                  const succ = barByTaskId.get(d.successor_id);
                  if (!pred || !succ) return null;
                  const x1 = (pred.startDayIndex + pred.widthDays) * dayWidth - 2;
                  const y1 = pred.rowIndex * rowHeight + rowHeight / 2;
                  const x2 = succ.startDayIndex * dayWidth;
                  const y2 = succ.rowIndex * rowHeight + rowHeight / 2;
                  const midX = x2 - 6;
                  const path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
                  return (
                    <path
                      key={`${d.predecessor_id}-${d.successor_id}`}
                      d={path}
                      stroke="#9097A0"
                      strokeWidth={1}
                      fill="none"
                      markerEnd="url(#arrow)"
                      opacity={0.5}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>

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

      {isAdmin ? (
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
      ) : null}
    </>
  );
}

function CursorMenu({
  open,
  onToggleOpen,
  milestones,
  hidden,
  onToggle,
  isAdmin,
  onEditMilestone,
  onDeleteMilestone,
  onNewMilestone,
}: {
  open: boolean;
  onToggleOpen: () => void;
  milestones: ReadonlyArray<Milestone>;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  isAdmin: boolean;
  onEditMilestone: (m: Milestone) => void;
  onDeleteMilestone: (m: Milestone) => void;
  onNewMilestone: () => void;
}) {
  const shown = milestones.length - hidden.size;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        className="inline-flex items-center gap-1.5 rounded border border-helios-line bg-helios-panel px-2 py-1 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
      >
        <IconEye size={12} strokeWidth={1.5} />
        Cursors
        <span className="tabular-nums text-helios-dim/70">
          {shown}/{milestones.length}
        </span>
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-helios-line bg-helios-panel p-1 shadow-lg">
          {milestones.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-helios-dim">No milestones.</p>
          ) : (
            milestones.map((m) => {
              const isHidden = hidden.has(m.id);
              const days = differenceInCalendarDays(
                startOfDay(parseISO(m.target_date)),
                startOfDay(new Date()),
              );
              const countdown =
                days === 0 ? "today" : days > 0 ? `${days}d out` : `${Math.abs(days)}d ago`;
              return (
                <div
                  key={m.id}
                  className="group flex w-full items-center gap-1 rounded pr-1 hover:bg-helios-base"
                >
                  <button
                    type="button"
                    onClick={() => onToggle(m.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left"
                    title={isHidden ? "Show cursor" : "Hide cursor"}
                  >
                    {isHidden ? (
                      <IconEyeOff size={14} strokeWidth={1.5} className="shrink-0 text-helios-dim" />
                    ) : (
                      <IconEye size={14} strokeWidth={1.5} className="shrink-0 text-asu-gold" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          "block truncate text-xs font-normal " +
                          (isHidden ? "text-helios-dim" : "text-helios-text")
                        }
                      >
                        {m.name}
                      </span>
                      <span className="block truncate text-[10px] text-helios-dim">
                        {MILESTONE_TYPE_LABEL[m.type]} · {format(parseISO(m.target_date), "MMM d")} · {countdown}
                      </span>
                    </span>
                  </button>
                  {isAdmin ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => onEditMilestone(m)}
                        aria-label={`Edit ${m.name}`}
                        title="Edit milestone"
                        className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-helios-text"
                      >
                        <IconEdit size={13} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteMilestone(m)}
                        aria-label={`Delete ${m.name}`}
                        title="Delete milestone"
                        className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-red-400"
                      >
                        <IconTrash size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {isAdmin ? (
            <button
              type="button"
              onClick={onNewMilestone}
              className="mt-1 flex w-full items-center gap-1.5 rounded border-t border-helios-line px-2 py-1.5 text-left text-xs font-normal text-asu-gold hover:bg-helios-base"
            >
              <IconPlus size={13} strokeWidth={1.5} />
              New milestone
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ZoomGroup({
  label,
  value,
  suffix,
  onMinus,
  onPlus,
  minusDisabled,
  plusDisabled,
}: {
  label: string;
  value: number;
  suffix: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled: boolean;
  plusDisabled: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-helios-line bg-helios-panel p-0.5 text-[11px]">
      <span className="px-1 text-helios-dim">{label}</span>
      <button
        type="button"
        onClick={onMinus}
        disabled={minusDisabled}
        className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:opacity-40"
        aria-label={`${label} smaller`}
      >
        <IconMinus size={12} strokeWidth={1.5} />
      </button>
      <span className="min-w-[2.5rem] text-center text-helios-text tabular-nums">
        {value}
        <span className="text-helios-dim"> {suffix}</span>
      </span>
      <button
        type="button"
        onClick={onPlus}
        disabled={plusDisabled}
        className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:opacity-40"
        aria-label={`${label} larger`}
      >
        <IconPlus size={12} strokeWidth={1.5} />
      </button>
    </div>
  );
}
