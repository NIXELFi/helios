"use client";

import type { CalendarEvent, TaskRow } from "@helios/pm-ui";
import { STATUS_DOT, STATUS_LABEL, TASK_TYPE_LABEL, daysUntilDue } from "@helios/pm-ui";
import {
  IconBoxMultiple,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutDashboard,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { addDays, addMonths, format, parseISO, startOfDay } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { ViewHeader } from "@pm/components/ViewHeader";
import { Select } from "@pm/components/ui/Select";
import { SubsystemEditor } from "@pm/components/SubsystemEditor";
import { scopeTasksToSubteam, selectIsAdmin, usePmStore, type CrossTeamRelation } from "@pm/lib/pmStore";
import { usePrimaryOnly } from "@pm/lib/primaryOnly";
import { PrimaryOnlyToggle } from "@pm/components/PrimaryOnlyToggle";
import { useScrollMemory } from "@pm/lib/useScrollMemory";
import { useDashboardPhotos, type DashboardPhoto } from "@pm/lib/useDashboardPhotos";
import {
  GROUP_KEYS,
  GROUP_LABEL,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_BUCKET_LABEL,
  HISTOGRAM_FIELDS,
  HISTOGRAM_FIELD_LABEL,
  METRIC_KEYS,
  METRIC_LABEL,
  PRIORITY_LABEL,
  TASK_SET_LABEL,
  WORKLOAD_MEASURE_LABEL,
  computeMetric,
  filterSet,
  groupTasks,
  subteamStats,
  taskDateHistogram,
  workloadByOwner,
  type Bucket,
  type GroupKey,
  type HistogramBucketSize,
  type HistogramDateField,
  type HistogramResult,
  type MetricResult,
  type MetricTone,
  type TaskSet,
  type WorkloadMeasure,
} from "@pm/lib/dashboardMetrics";
import {
  DEFAULT_WINDOW_DAYS,
  SIZE_LABEL,
  SIZE_SPAN_CLASS,
  WIDGET_KIND_META,
  WIDGET_SIZES,
  activeTab,
  addTab,
  addWidget,
  deleteTab,
  kindAvailable,
  moveWidget,
  removeWidget,
  renameTab,
  setActiveTab,
  updateWidget,
  type ChartKind,
  type CrossDirection,
  type DashboardConfig,
  type Widget,
  type WidgetKind,
  type WidgetSize,
} from "@pm/lib/dashboardSettings";
import { useSharedDashboardLayout, type SharedLayoutStatus } from "@pm/lib/useSharedDashboardLayout";

const FALLBACK_COLOR = "#6B7280";

function dueText(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return `${-days}d overdue`;
}

// Next on-or-after-today occurrence of an event (handles recurrence). Returns
// null if the (non-recurring) event is in the past or recurrence has ended.
function nextEventDate(ev: CalendarEvent, today: Date): Date | null {
  const start = parseISO(ev.date);
  const rec = ev.recurrence ?? "none";
  if (rec === "none") return start >= today ? start : null;
  const end = ev.recurrence_end ? parseISO(ev.recurrence_end) : null;
  let cur = start;
  let guard = 0;
  while (cur < today && guard < 1000) {
    cur = rec === "daily" ? addDays(cur, 1) : rec === "weekly" ? addDays(cur, 7) : addMonths(cur, 1);
    guard++;
  }
  if (end && cur > end) return null;
  return cur;
}

export function DashboardViewClient({ teamSlug = null }: { teamSlug?: string | null }) {
  const scrollMemRef = useScrollMemory(`dashboard:${teamSlug ?? "__project__"}`);
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const deps = usePmStore((s) => s.dependencies);
  const events = usePmStore((s) => s.events);
  const selectTask = usePmStore((s) => s.selectTask);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;
  const allTeams = currentTeam === null;
  const isSubteamScope = currentTeam !== null;
  const [primaryOnly, setPrimaryOnly] = usePrimaryOnly();

  // Per-scope layout (tabs of widget instances), SHARED across the team:
  // server-persisted, editable only with pm.manage_dashboard in this scope,
  // cached in localStorage for offline. PmModule keys this component per
  // scope so the hook state is a fresh instance per scope (and the hook also
  // self-resets if the scope props ever change without a remount).
  const { config, setConfig, canEdit, status, retry } = useSharedDashboardLayout({
    subteamId: currentTeam?.id ?? null,
    teamSlug,
    isSubteamScope,
  });
  const [editing, setEditing] = useState(false);
  const [subsystemsOpen, setSubsystemsOpen] = useState(false);
  const isAdmin = usePmStore(selectIsAdmin);
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  const tab = activeTab(config);

  const scoped = useMemo(
    () =>
      currentTeam
        ? scopeTasksToSubteam(tasks, deps, currentTeam.id, primaryOnly)
        : tasks.map((task) => ({
            task,
            relation: "owned" as CrossTeamRelation,
            bridgeTaskIds: [] as string[],
          })),
    [tasks, deps, currentTeam, primaryOnly],
  );
  const owned = useMemo(() => scoped.filter((r) => r.relation === "owned").map((r) => r.task), [scoped]);
  const prerequisites = useMemo(() => scoped.filter((r) => r.relation === "prerequisite_of_team"), [scoped]);
  const dependents = useMemo(() => scoped.filter((r) => r.relation === "dependent_on_team"), [scoped]);

  const scopedEvents = useMemo(() => {
    const today = startOfDay(new Date());
    const list = currentTeam
      ? events.filter((e) => e.all_subteams || e.subteam_ids.includes(currentTeam.id))
      : events;
    return list
      .map((e) => ({ e, when: nextEventDate(e, today) }))
      .filter((x): x is { e: CalendarEvent; when: Date } => x.when !== null)
      .sort((a, b) => a.when.getTime() - b.when.getTime());
  }, [events, currentTeam]);

  function renderBody(w: Widget) {
    switch (w.kind) {
      case "metric":
        return <MetricTile result={computeMetric(owned, w.metric)} />;
      case "breakdown": {
        const set = filterSet(owned, w.set, w.windowDays);
        const { buckets, total } = groupTasks(set, w.groupBy);
        if (total === 0) return <Empty>No tasks in this set.</Empty>;
        return w.chart === "donut" ? (
          <BucketDonut buckets={buckets} total={total} />
        ) : (
          <BucketBars buckets={buckets} total={total} />
        );
      }
      case "deadlines":
        return <DeadlinesTable owned={owned} windowDays={w.windowDays} allTeams={allTeams} onSelect={selectTask} />;
      case "events":
        return <EventsList rows={scopedEvents.slice(0, w.limit)} />;
      case "cross":
        return (
          <CrossTeamList
            rows={w.direction === "prereq" ? prerequisites : dependents}
            empty={w.direction === "prereq" ? "No external prerequisites." : "No external dependents."}
            onSelect={selectTask}
          />
        );
      case "workload": {
        const set = filterSet(owned, w.set, w.windowDays);
        const { rows, max } = workloadByOwner(set, w.measure);
        if (rows.length === 0) return <Empty>No load to show.</Empty>;
        return <WorkloadBars rows={rows} max={max} measure={w.measure} />;
      }
      case "histogram": {
        const set = filterSet(owned, w.set, DEFAULT_WINDOW_DAYS);
        const result = taskDateHistogram(set, w.field, w.bucket);
        if (result.total === 0)
          return <Empty>No {HISTOGRAM_FIELD_LABEL[w.field].toLowerCase()}s to chart.</Empty>;
        return <HistogramColumns result={result} />;
      }
      case "subteam_table":
        return <SubteamTable stats={subteamStats(owned)} />;
      case "photos":
        return <PhotoWidget subteamId={currentTeam?.id ?? null} />;
    }
  }

  function widgetTitle(w: Widget): string {
    switch (w.kind) {
      case "metric":
        return METRIC_LABEL[w.metric];
      case "breakdown":
        return `By ${GROUP_LABEL[w.groupBy].toLowerCase()}`;
      case "deadlines":
        return "Upcoming deadlines";
      case "events":
        return "Upcoming events";
      case "cross":
        return w.direction === "prereq" ? "Prerequisites from other subteams" : "Subteams depending on us";
      case "workload":
        return `Workload · ${WORKLOAD_MEASURE_LABEL[w.measure]}`;
      case "histogram":
        return `${HISTOGRAM_FIELD_LABEL[w.field]} histogram`;
      case "subteam_table":
        return "Subteam comparison";
      case "photos":
        return "Photos";
    }
  }

  const availableKinds = (Object.keys(WIDGET_KIND_META) as WidgetKind[]).filter((k) =>
    kindAvailable(k, isSubteamScope),
  );

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Dashboard` : "All Subteams · Dashboard"}
        description="Upcoming deadlines, completion at a glance, and what's coming up — distilled."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isSubteamScope ? (
              <PrimaryOnlyToggle value={primaryOnly} onChange={setPrimaryOnly} />
            ) : null}
            {allTeams && isAdmin ? (
              <button
                type="button"
                onClick={() => setSubsystemsOpen(true)}
                className="inline-flex items-center gap-1.5 rounded border border-helios-line px-3 py-1.5 text-sm font-medium text-helios-text transition-colors hover:bg-helios-base"
              >
                <IconBoxMultiple size={16} strokeWidth={1.5} />
                Subsystems
              </button>
            ) : null}
            <LayoutSyncBadge status={status} onRetry={retry} />
            {canEdit ? (
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                aria-pressed={editing}
                className={
                  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium transition-colors " +
                  (editing
                    ? "border-asu-gold bg-asu-gold/15 text-asu-gold"
                    : "border-helios-line text-helios-text hover:bg-helios-base")
                }
              >
                <IconLayoutDashboard size={16} strokeWidth={1.5} />
                {editing ? "Done" : "Customize"}
              </button>
            ) : null}
          </div>
        }
      />
      {allTeams && isAdmin ? (
        <SubsystemEditor open={subsystemsOpen} onClose={() => setSubsystemsOpen(false)} />
      ) : null}

      <TabStrip
        config={config}
        editing={editing}
        canEdit={canEdit}
        onSelect={(id) => setConfig((c) => setActiveTab(c, id))}
        onAdd={() => {
          setConfig((c) => addTab(c, `Tab ${c.tabs.length + 1}`));
          setEditing(true);
        }}
        onRename={(id, name) => setConfig((c) => renameTab(c, id, name))}
        onDelete={(id) => setConfig((c) => deleteTab(c, id))}
      />

      <div ref={scrollMemRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        {editing ? (
          <AddWidgetBar kinds={availableKinds} onAdd={(k) => setConfig((c) => addWidget(c, k))} />
        ) : null}

        {tab.widgets.length === 0 ? (
          <p className="mt-10 text-center text-xs text-helios-dim">
            This tab is empty.{" "}
            {editing ? (
              "Add a widget above."
            ) : canEdit ? (
              <>
                Click <span className="text-helios-text">Customize</span> to add widgets.
              </>
            ) : (
              "A lead or exec can add widgets here."
            )}
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-6">
            {tab.widgets.map((w, i) => (
              <WidgetCard
                key={w.id}
                widget={w}
                title={widgetTitle(w)}
                editing={editing}
                isFirst={i === 0}
                isLast={i === tab.widgets.length - 1}
                onUpdate={(patch) => setConfig((c) => updateWidget(c, w.id, patch))}
                onRemove={() => setConfig((c) => removeWidget(c, w.id))}
                onMove={(dir) => setConfig((c) => moveWidget(c, w.id, dir))}
              >
                {renderBody(w)}
              </WidgetCard>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// --- Tabs -------------------------------------------------------------------

function TabStrip({
  config,
  editing,
  canEdit,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  config: DashboardConfig;
  editing: boolean;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startRename(id: string, name: string) {
    setRenamingId(id);
    setDraft(name);
  }
  function commitRename() {
    if (renamingId) onRename(renamingId, draft);
    setRenamingId(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-helios-line bg-helios-panel/40 px-4 pt-2">
      {config.tabs.map((t) => {
        const active = t.id === config.activeTabId;
        const renaming = renamingId === t.id;
        return (
          <div
            key={t.id}
            className={
              "relative -mb-px flex items-center gap-1.5 rounded-t-lg border-x border-t px-3 py-2 text-xs font-medium transition-colors " +
              (active
                ? "border-helios-line bg-helios-base text-helios-text"
                : "border-transparent text-helios-dim hover:text-helios-text")
            }
          >
            {renaming ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="w-28 rounded border border-asu-gold bg-helios-panel px-1 py-0.5 text-xs text-helios-text focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                onDoubleClick={canEdit ? () => startRename(t.id, t.name) : undefined}
                title={editing ? "Double-click to rename" : undefined}
                className="max-w-[14rem] truncate"
              >
                {t.name}
              </button>
            )}
            {editing && config.tabs.length > 1 && !renaming ? (
              <button
                type="button"
                aria-label={`Delete tab ${t.name}`}
                onClick={() => {
                  if (confirm(`Delete dashboard tab "${t.name}"?`)) onDelete(t.id);
                }}
                className="rounded p-0.5 text-helios-dim hover:bg-helios-line/60 hover:text-red-400"
              >
                <IconX size={13} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        );
      })}
      {canEdit ? (
        <button
          type="button"
          onClick={onAdd}
          aria-label="New tab"
          title="New tab"
          className="-mb-px ml-1 flex items-center gap-1 rounded-t-lg px-2 py-2 text-xs text-helios-dim hover:bg-helios-base/50 hover:text-helios-text"
        >
          <IconPlus size={15} strokeWidth={1.5} />
          New
        </button>
      ) : null}
    </div>
  );
}

// Quiet header note about the shared layout's sync state. Silent when synced
// (or before the first fetch resolves) — it only speaks up when the user
// should know their view is a cached copy or an edit hasn't landed yet.
function LayoutSyncBadge({ status, onRetry }: { status: SharedLayoutStatus; onRetry: () => void }) {
  if (status === "saving") {
    return <span className="text-[11px] text-helios-dim">Saving layout…</span>;
  }
  if (status === "offline") {
    return (
      <span
        className="text-[11px] text-helios-dim"
        title="Couldn't reach the server — showing the last layout this machine saw."
      >
        Offline copy
      </span>
    );
  }
  if (status === "save_error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-400">
        Layout not saved
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-amber-400/40 px-1.5 py-0.5 hover:bg-amber-400/10"
        >
          Retry
        </button>
      </span>
    );
  }
  return null;
}

// --- Add-widget palette -----------------------------------------------------

function AddWidgetBar({ kinds, onAdd }: { kinds: WidgetKind[]; onAdd: (k: WidgetKind) => void }) {
  return (
    <section className="mt-4 rounded-lg border border-asu-gold/40 bg-helios-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Add widget</span>
        {kinds.map((k) => {
          const meta = WIDGET_KIND_META[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => onAdd(k)}
              title={meta.blurb}
              className="inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base px-2.5 py-1 text-xs text-helios-text hover:border-asu-gold hover:text-asu-gold"
            >
              <IconPlus size={13} strokeWidth={1.5} />
              {meta.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// --- Widget card (shell + in-place config) ----------------------------------

function WidgetCard({
  widget,
  title,
  editing,
  isFirst,
  isLast,
  onUpdate,
  onRemove,
  onMove,
  children,
}: {
  widget: Widget;
  title: string;
  editing: boolean;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (patch: (w: Widget) => Widget) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        "rounded-lg border bg-helios-panel p-4 " +
        SIZE_SPAN_CLASS[widget.size] +
        " " +
        (editing ? "border-asu-gold/40" : "border-helios-line")
      }
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-widest text-helios-dim">{title}</h3>
        {editing ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Move left"
              disabled={isFirst}
              onClick={() => onMove(-1)}
              className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:opacity-30"
            >
              <IconChevronLeft size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Move right"
              disabled={isLast}
              onClick={() => onMove(1)}
              className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:opacity-30"
            >
              <IconChevronRight size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Remove widget"
              onClick={onRemove}
              className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
            >
              <IconTrash size={14} strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
      </div>

      {editing ? <WidgetConfigBar widget={widget} onUpdate={onUpdate} /> : null}

      {children}
    </section>
  );
}

function WidgetConfigBar({
  widget,
  onUpdate,
}: {
  widget: Widget;
  onUpdate: (patch: (w: Widget) => Widget) => void;
}) {
  const sizeSelect = (
    <MiniSelect
      label="Size"
      value={widget.size}
      ariaLabel="Widget size"
      onChange={(v) => onUpdate((w) => ({ ...w, size: v as WidgetSize }) as Widget)}
      options={WIDGET_SIZES.map((s) => ({ value: s, label: SIZE_LABEL[s] }))}
    />
  );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-helios-line bg-helios-base/40 px-2.5 py-2">
      {widget.kind === "breakdown" ? (
        <>
          <MiniSelect
            label="By"
            value={widget.groupBy}
            ariaLabel="Group by"
            onChange={(v) => onUpdate((w) => (w.kind === "breakdown" ? { ...w, groupBy: v as GroupKey } : w))}
            options={GROUP_KEYS.map((g) => ({ value: g, label: GROUP_LABEL[g] }))}
          />
          <MiniSelect
            label="Chart"
            value={widget.chart}
            ariaLabel="Chart type"
            onChange={(v) => onUpdate((w) => (w.kind === "breakdown" ? { ...w, chart: v as ChartKind } : w))}
            options={[
              { value: "donut", label: "Donut" },
              { value: "bar", label: "Bars" },
            ]}
          />
          <MiniSelect
            label="Set"
            value={widget.set}
            ariaLabel="Task set"
            onChange={(v) => onUpdate((w) => (w.kind === "breakdown" ? { ...w, set: v as TaskSet } : w))}
            options={(Object.keys(TASK_SET_LABEL) as TaskSet[]).map((s) => ({ value: s, label: TASK_SET_LABEL[s] }))}
          />
        </>
      ) : null}

      {widget.kind === "metric" ? (
        <MiniSelect
          label="Metric"
          value={widget.metric}
          ariaLabel="Metric"
          className="min-w-[150px]"
          onChange={(v) =>
            onUpdate((w) => (w.kind === "metric" ? { ...w, metric: v as (typeof METRIC_KEYS)[number] } : w))
          }
          options={METRIC_KEYS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
        />
      ) : null}

      {widget.kind === "cross" ? (
        <MiniSelect
          label="Direction"
          value={widget.direction}
          ariaLabel="Direction"
          onChange={(v) => onUpdate((w) => (w.kind === "cross" ? { ...w, direction: v as CrossDirection } : w))}
          options={[
            { value: "prereq", label: "Prerequisites" },
            { value: "dependent", label: "Dependents" },
          ]}
        />
      ) : null}

      {widget.kind === "workload" ? (
        <>
          <MiniSelect
            label="Measure"
            value={widget.measure}
            ariaLabel="Measure"
            onChange={(v) => onUpdate((w) => (w.kind === "workload" ? { ...w, measure: v as WorkloadMeasure } : w))}
            options={(Object.keys(WORKLOAD_MEASURE_LABEL) as WorkloadMeasure[]).map((m) => ({
              value: m,
              label: WORKLOAD_MEASURE_LABEL[m],
            }))}
          />
          <MiniSelect
            label="Set"
            value={widget.set}
            ariaLabel="Task set"
            onChange={(v) => onUpdate((w) => (w.kind === "workload" ? { ...w, set: v as TaskSet } : w))}
            options={(Object.keys(TASK_SET_LABEL) as TaskSet[]).map((s) => ({ value: s, label: TASK_SET_LABEL[s] }))}
          />
        </>
      ) : null}

      {widget.kind === "histogram" ? (
        <>
          <MiniSelect
            label="By"
            value={widget.field}
            ariaLabel="Date field"
            onChange={(v) => onUpdate((w) => (w.kind === "histogram" ? { ...w, field: v as HistogramDateField } : w))}
            options={HISTOGRAM_FIELDS.map((f) => ({ value: f, label: HISTOGRAM_FIELD_LABEL[f] }))}
          />
          <MiniSelect
            label="Buckets"
            value={widget.bucket}
            ariaLabel="Bucket size"
            onChange={(v) => onUpdate((w) => (w.kind === "histogram" ? { ...w, bucket: v as HistogramBucketSize } : w))}
            options={HISTOGRAM_BUCKETS.map((b) => ({ value: b, label: HISTOGRAM_BUCKET_LABEL[b] }))}
          />
          <MiniSelect
            label="Set"
            value={widget.set}
            ariaLabel="Task set"
            onChange={(v) => onUpdate((w) => (w.kind === "histogram" ? { ...w, set: v as TaskSet } : w))}
            options={(Object.keys(TASK_SET_LABEL) as TaskSet[]).map((s) => ({ value: s, label: TASK_SET_LABEL[s] }))}
          />
        </>
      ) : null}

      {widget.kind === "deadlines" ? (
        <MiniNumber
          label="Window (days)"
          value={widget.windowDays}
          min={1}
          max={90}
          onChange={(n) => onUpdate((w) => (w.kind === "deadlines" ? { ...w, windowDays: n } : w))}
        />
      ) : null}

      {widget.kind === "events" ? (
        <MiniNumber
          label="Events"
          value={widget.limit}
          min={1}
          max={30}
          onChange={(n) => onUpdate((w) => (w.kind === "events" ? { ...w, limit: n } : w))}
        />
      ) : null}

      <span className="ml-auto">{sizeSelect}</span>
    </div>
  );
}

function MiniSelect({
  label,
  value,
  ariaLabel,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  ariaLabel: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-helios-dim">
      {label}
      <Select size="sm" value={value} ariaLabel={ariaLabel} className={className ?? "min-w-[96px]"} onChange={onChange} options={options} />
    </label>
  );
}

function MiniNumber({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-helios-dim">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
        className="w-16 rounded border border-helios-line bg-helios-base px-1.5 py-1 text-xs text-helios-text focus:border-asu-gold focus:outline-none"
      />
    </label>
  );
}

// --- Widget bodies ----------------------------------------------------------

const TONE_TEXT: Record<MetricTone, string> = {
  neutral: "text-helios-text",
  good: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
};
const TONE_BAR: Record<MetricTone, string> = {
  neutral: "bg-asu-gold/70",
  good: "bg-emerald-400/70",
  warn: "bg-amber-400/70",
  bad: "bg-red-400/70",
};

function MetricTile({ result }: { result: MetricResult }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={"text-3xl font-semibold tabular-nums " + TONE_TEXT[result.tone]}>{result.value}</span>
      {result.sub ? <span className="text-[11px] text-helios-dim">{result.sub}</span> : null}
      {result.ratio !== null ? (
        <span className="mt-0.5 h-1.5 overflow-hidden rounded bg-helios-base">
          <span
            className={"block h-full rounded " + TONE_BAR[result.tone]}
            style={{ width: `${Math.round(result.ratio * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

function BucketDonut({ buckets, total }: { buckets: Bucket[]; total: number }) {
  const size = 132;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          {buckets.map((b) => {
            const frac = b.count / total;
            const dash = frac * C;
            const el = (
              <circle
                key={b.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={b.color}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-acc * C}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            acc += frac;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-medium tabular-nums text-helios-text">{total}</span>
          <span className="text-[10px] uppercase tracking-widest text-helios-dim">tasks</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {buckets.map((b) => (
          <li key={b.key} className="flex items-center gap-2 text-xs">
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: b.color }} />
            <span className="min-w-0 flex-1 truncate text-helios-dim">{b.label}</span>
            <span className="shrink-0 tabular-nums text-helios-text">{Math.round((b.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BucketBars({ buckets, total }: { buckets: Bucket[]; total: number }) {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  return (
    <ul className="flex flex-col gap-2">
      {buckets.map((b) => (
        <li key={b.key} className="flex items-center gap-2 text-xs">
          <span className="flex w-24 shrink-0 items-center gap-1.5 text-helios-dim">
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: b.color }} />
            <span className="truncate">{b.label}</span>
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded bg-helios-base">
            <span
              className="block h-full rounded"
              style={{ width: `${max ? (b.count / max) * 100 : 0}%`, backgroundColor: b.color }}
            />
          </span>
          <span className="w-12 shrink-0 text-right tabular-nums text-helios-text">
            {b.count}
            <span className="ml-1 text-helios-dim">{Math.round((b.count / total) * 100)}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function HistogramColumns({ result }: { result: HistogramResult }) {
  const max = result.bars.reduce((m, b) => Math.max(m, b.count), 0);
  const first = result.bars[0]?.label ?? "";
  const last = result.bars[result.bars.length - 1]?.label ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-32 items-end gap-1 overflow-x-auto pb-0.5">
        {result.bars.map((b) => (
          <div
            key={b.key}
            title={`${b.label}: ${b.count}`}
            className="flex h-full min-w-[12px] flex-1 flex-col items-center justify-end gap-1"
          >
            <span className="text-[10px] leading-none tabular-nums text-helios-dim">{b.count || ""}</span>
            <span
              className="w-full rounded-t bg-asu-gold/70"
              style={{ height: `${max ? Math.max(b.count > 0 ? 3 : 0, (b.count / max) * 100) : 0}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-helios-dim">
        <span className="truncate">{first}</span>
        <span className="shrink-0 uppercase tracking-widest">{result.granularity}</span>
        <span className="truncate text-right">{last}</span>
      </div>
      {result.undated > 0 ? (
        <span className="text-[10px] text-helios-dim">{result.undated} undated excluded</span>
      ) : null}
    </div>
  );
}

function WorkloadBars({
  rows,
  max,
  measure,
}: {
  rows: { key: string; label: string; color: string; value: number }[];
  max: number;
  measure: WorkloadMeasure;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-2 text-xs">
          <span className="flex w-28 shrink-0 items-center gap-1.5 text-helios-dim">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
            <span className="truncate">{r.label}</span>
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded bg-helios-base">
            <span
              className="block h-full rounded"
              style={{ width: `${max ? (r.value / max) * 100 : 0}%`, backgroundColor: r.color }}
            />
          </span>
          <span className="w-16 shrink-0 text-right tabular-nums text-helios-text">
            {measure === "estimate" ? `${r.value}d` : r.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DeadlinesTable({
  owned,
  windowDays,
  allTeams,
  onSelect,
}: {
  owned: TaskRow[];
  windowDays: number;
  allTeams: boolean;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const r = owned
      .filter((t) => t.status !== "done")
      .map((t) => ({ t, d: daysUntilDue(t.due_date) }))
      .filter((x): x is { t: TaskRow; d: number } => x.d !== null && x.d <= windowDays);
    r.sort((a, b) => a.d - b.d);
    return r;
  }, [owned, windowDays]);

  if (rows.length === 0) return <Empty>Nothing due in the next {windowDays} days. 🎉</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-widest text-helios-dim">
          <tr className="border-b border-helios-line">
            <th className="py-1.5 pr-3 font-medium">Task</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 font-medium">Days left</th>
            <th className="py-1.5 pr-3 font-medium">Priority</th>
            <th className="py-1.5 pr-3 font-medium">Owner</th>
            <th className="py-1.5 pr-3 font-medium">Type</th>
            <th className="py-1.5 pr-3 font-medium">{allTeams ? "Subteam" : "Subsystem"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, d }) => (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="cursor-pointer border-b border-helios-line/50 hover:bg-helios-base/50"
            >
              <td className="max-w-[18rem] truncate py-1.5 pr-3 text-helios-text">{t.title}</td>
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5 text-helios-text">
                  <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: STATUS_DOT[t.status] }} />
                  {STATUS_LABEL[t.status]}
                </span>
              </td>
              <td className={"py-1.5 pr-3 tabular-nums " + (d < 0 ? "text-red-400" : d <= 2 ? "text-orange-400" : "text-helios-text")}>
                {dueText(d)}
              </td>
              <td className="py-1.5 pr-3 text-helios-text">{PRIORITY_LABEL[t.priority]}</td>
              <td className="py-1.5 pr-3 text-helios-dim">{t.owner?.name ?? "Unassigned"}</td>
              <td className="py-1.5 pr-3 text-helios-dim">{TASK_TYPE_LABEL[t.type]}</td>
              <td className="py-1.5 pr-3">
                {allTeams ? (
                  <span className="inline-flex items-center gap-1.5 text-helios-text">
                    <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.subteam.color ?? FALLBACK_COLOR }} />
                    {t.subteam.name}
                  </span>
                ) : (
                  <span className="text-helios-text">{t.subsystem?.name ?? "—"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventsList({ rows }: { rows: { e: CalendarEvent; when: Date }[] }) {
  if (rows.length === 0) return <Empty>Nothing scheduled.</Empty>;
  const today = startOfDay(new Date()).getTime();
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map(({ e, when }) => {
        const days = Math.round((startOfDay(when).getTime() - today) / 86400000);
        return (
          <li key={`${e.id}-${when.toISOString()}`} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-helios-text">{e.title}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-helios-dim">{format(when, "MMM d")}</span>
            <span className={"shrink-0 text-[11px] tabular-nums " + (days <= 14 ? "text-asu-gold" : "text-helios-text")}>
              {days === 0 ? "today" : `in ${days}d`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CrossTeamList({
  rows,
  empty,
  onSelect,
}: {
  rows: Array<{ task: TaskRow; relation: CrossTeamRelation }>;
  empty: string;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => (
        <li key={r.task.id}>
          <button
            type="button"
            onClick={() => onSelect(r.task.id)}
            className="flex w-full items-center gap-2 rounded border border-helios-line bg-helios-base/30 px-2 py-1.5 text-left text-xs hover:bg-helios-base"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[r.task.status] }} />
            <span className="min-w-0 flex-1 truncate text-helios-text">{r.task.title}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-helios-dim">{r.task.subteam.code}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SubteamTable({ stats }: { stats: ReturnType<typeof subteamStats> }) {
  if (stats.length === 0) return <Empty>No tasks.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-widest text-helios-dim">
          <tr className="border-b border-helios-line">
            <th className="py-1.5 pr-3 font-medium">Subteam</th>
            <th className="py-1.5 pr-3 text-right font-medium">Total</th>
            <th className="py-1.5 pr-3 text-right font-medium">Open</th>
            <th className="py-1.5 pr-3 text-right font-medium">Overdue</th>
            <th className="py-1.5 pr-3 font-medium">Completion</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.id} className="border-b border-helios-line/50">
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5 text-helios-text">
                  <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.name}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-helios-text">{s.total}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-helios-text">{s.open}</td>
              <td className={"py-1.5 pr-3 text-right tabular-nums " + (s.overdue ? "text-red-400" : "text-helios-dim")}>
                {s.overdue}
              </td>
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-20 overflow-hidden rounded bg-helios-base">
                    <span
                      className="block h-full rounded bg-emerald-400/70"
                      style={{ width: `${Math.round(s.completion * 100)}%` }}
                    />
                  </span>
                  <span className="tabular-nums text-helios-dim">{Math.round(s.completion * 100)}%</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhotoWidget({ subteamId }: { subteamId: string | null }) {
  const { loading, error, photos, canManage, uploading, upload, remove } = useDashboardPhotos(subteamId);
  const fileRef = useRef<HTMLInputElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (file) void upload(file);
  }

  function onDelete(photo: DashboardPhoto) {
    if (confirm("Remove this photo?")) void remove(photo);
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base px-2.5 py-1 text-xs text-helios-text hover:border-asu-gold hover:text-asu-gold disabled:opacity-50"
          >
            <IconPlus size={13} strokeWidth={1.5} />
            {uploading ? "Uploading…" : "Add photo"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPick}
          />
        </div>
      ) : null}

      {error ? <p className="text-xs text-red-400">{error}</p> : null}

      {loading ? (
        <p className="text-xs text-helios-dim">Loading photos…</p>
      ) : photos.length === 0 ? (
        <Empty>No photos yet.</Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="group flex flex-col gap-1">
              <div className="relative overflow-hidden rounded border border-helios-line bg-helios-base">
                <div className="aspect-square w-full">
                  {p.url ? (
                    <img
                      src={p.url}
                      alt={p.caption ?? "Dashboard photo"}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-[10px] text-helios-dim">
                      Unavailable
                    </div>
                  )}
                </div>
                {canManage ? (
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => onDelete(p)}
                    className="absolute right-1 top-1 rounded bg-helios-panel/80 p-0.5 text-helios-dim opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  >
                    <IconX size={13} strokeWidth={2} />
                  </button>
                ) : null}
              </div>
              {p.caption ? (
                <span className="truncate text-[11px] text-helios-dim" title={p.caption}>
                  {p.caption}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-helios-dim">{children}</p>;
}
