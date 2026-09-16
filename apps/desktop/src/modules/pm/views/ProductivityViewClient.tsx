"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useSupabaseClient } from "@helios/auth";
import { IconArrowRight } from "@tabler/icons-react";
import { ViewHeader } from "@pm/components/ViewHeader";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { SegmentedControl } from "@pm/components/ui/SegmentedControl";
import { FilterField, filterInput } from "@pm/components/TaskFilterBar";
import { usePmStore } from "@pm/lib/pmStore";
import { useScrollMemory } from "@pm/lib/useScrollMemory";
import { viewHref } from "@pm/lib/nav";
import { EMPTY_FILTERS, filtersToParams, type TaskFilters } from "@pm/lib/filters";
import { fetchTaskHistory, type TaskHistoryFailure, type TaskHistoryRow } from "@pm/lib/taskHistory";
import { STATUS_DOT, STATUS_LABEL, type Milestone, type Subteam, type TaskStatus } from "@helios/pm-ui";
import type { FrameMilestone } from "@pm/components/charts/ChartFrame";
import { Link } from "@pm/lib/router";
import {
  attentionLists,
  buildProductivity,
  isoWeekKey,
  isoWeekStart,
  localDayKey,
  sliceWindow,
  stateCounts,
  subteamSummaries,
  weeklyCompletions,
  windowDeltas,
  workload,
  type AttentionItem,
  type AttentionLists,
  type ProductivityMetrics,
  type StateCounts,
  type SubteamSummary,
  type WindowDeltas,
  type Workload,
} from "@pm/lib/productivityMetrics";
import { StackedWeeks, type WeekColumn, type WeekSeries } from "@pm/components/charts/StackedWeeks";
import { BarStrip, type BarSegment } from "@pm/components/charts/BarStrip";
import { KpiTile } from "@pm/components/charts/KpiTile";
import { Delta } from "@pm/components/charts/Delta";
import { Sparkline } from "@pm/components/charts/Sparkline";
import { DayStrip } from "@pm/components/charts/DayStrip";
import {
  countExportableEvents,
  taskHistoryFileName,
  taskHistoryToCsv,
} from "@pm/lib/taskHistoryCsv";

import { tc } from "@helios/ui";
// ---------------------------------------------------------------------------
// Productivity — task history over time, read from the pm.task_history RPC and
// folded into charts by the pure productivityMetrics module. Charts are inline
// SVG, matching the dashboard; no chart library is pulled in for this.
//
// Person-level numbers are the server's call, not this component's: the RPC
// returns NULL actors unless the caller holds pm.manage_dashboard in scope, so
// the per-person table simply has nothing to render when it is not allowed.
// ---------------------------------------------------------------------------

const PRESETS = [
  { key: "week", label: "This week", weeks: null },
  { key: "4w", label: "4 weeks", weeks: 4 },
  { key: "12w", label: "12 weeks", weeks: 12 },
  { key: "season", label: "Season", weeks: null },
  { key: "custom", label: "Custom", weeks: null },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toDayInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fromDayInput(s: string): Date | null {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * The competition season starts on JUNE 1 — the design year begins right after
 * competition, not with the academic calendar. (There is no season table in
 * `pm`; this is the window the team plans its car around.)
 */
function seasonStart(now: Date): Date {
  const june = new Date(now.getFullYear(), 5, 1);
  return now >= june ? june : new Date(now.getFullYear() - 1, 5, 1);
}

function presetRange(key: PresetKey, now: Date): { from: Date; to: Date } | null {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (key === "season") return { from: seasonStart(now), to };
  // "This week" is the ISO week so far — Monday to now — because that is the
  // question a lead asks on any given morning, not "the last seven days".
  if (key === "week") return { from: isoWeekStart(now), to };
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset?.weeks) return null;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - preset.weeks * 7);
  return { from, to };
}

const OPEN_STATUSES = ["not_started", "in_progress", "blocked", "needs_review"] as const;
const SPARK_WEEKS = 12;
const STRIP_MIN_WEEKS = 8;

interface Range {
  from: Date;
  to: Date;
}

/**
 * The comparison window. Same length, ending the instant before `r` starts —
 * except for "This week", which compares against ALL of last week: on a
 * Monday morning the same-length rule would compare one day against one day
 * and read "0 vs 0", which answers nothing. A partial week against a full one
 * is the comparison a lead actually makes, and the label says so.
 */
function previousRange(r: Range, key: PresetKey): Range {
  const to = new Date(r.from.getTime() - 1);
  if (key === "week") {
    const from = isoWeekStart(r.from);
    from.setDate(from.getDate() - 7);
    return { from, to };
  }
  const len = r.to.getTime() - r.from.getTime();
  return { from: new Date(to.getTime() - len), to };
}

/**
 * ONE RPC pull feeds three readings: the selected window, the previous window
 * (deltas) and the trailing twelve weeks (sparklines and the Weeks strip's
 * context columns). Fetching the union and slicing client-side is cheaper than
 * three round trips and gives one loading state instead of three.
 */
function fetchRange(r: Range, key: PresetKey): Range {
  const prev = previousRange(r, key);
  const context = isoWeekStart(r.to);
  context.setDate(context.getDate() - 7 * (SPARK_WEEKS - 1));
  const from = new Date(Math.min(prev.from.getTime(), context.getTime()));
  return { from, to: r.to };
}

function compareLabel(key: PresetKey, r: Range): string {
  if (key === "week") return "vs all of last week";
  if (key === "4w") return "vs previous 4 weeks";
  if (key === "12w") return "vs previous 12 weeks";
  const days = Math.max(1, Math.round((r.to.getTime() - r.from.getTime()) / MS_PER_DAY));
  return `vs previous ${days} days`;
}

export interface ProductivityViewClientProps {
  teamSlug?: string | null;
}

export function ProductivityViewClient({ teamSlug = null }: ProductivityViewClientProps) {
  const scrollMemRef = useScrollMemory(`productivity:${teamSlug ?? "__project__"}`);
  const client = useSupabaseClient();
  const projectId = usePmStore((s) => s.projectId);
  const subteams = usePmStore((s) => s.subteams);
  const users = usePmStore((s) => s.users);
  const currentUserId = usePmStore((s) => s.currentUserId);
  const milestones = usePmStore((s) => s.milestones);

  const routeTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;

  const [preset, setPreset] = useState<PresetKey>("week");
  // Custom range, only consulted when preset === "custom".
  const [customFrom, setCustomFrom] = useState(() =>
    toDayInput(new Date(Date.now() - 84 * MS_PER_DAY)),
  );
  const [customTo, setCustomTo] = useState(() => toDayInput(new Date()));
  // Project-scope subteam filter. Inside /team/[slug] the route wins and this
  // picker is not rendered at all.
  const [pickedSubteamId, setPickedSubteamId] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);

  const [rows, setRows] = useState<TaskHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<TaskHistoryFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  const scopeSubteamId = routeTeam ? routeTeam.id : pickedSubteamId;
  const scopeLabel = routeTeam
    ? routeTeam.name
    : subteams.find((s) => s.id === pickedSubteamId)?.name ?? null;

  const range = useMemo(() => {
    if (preset === "custom") {
      const from = fromDayInput(customFrom);
      const to = fromDayInput(customTo);
      if (!from || !to) return null;
      to.setHours(23, 59, 59, 999);
      if (to < from) return null;
      return { from, to };
    }
    return presetRange(preset, new Date());
    // `new Date()` is read once per range recomputation, which is exactly when
    // the user changes the controls — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo]);

  const pull = useMemo(() => (range ? fetchRange(range, preset) : null), [range, preset]);

  useEffect(() => {
    if (!projectId || !pull) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void fetchTaskHistory(client, {
      projectId,
      from: pull.from,
      to: pull.to,
      subteamId: scopeSubteamId,
    }).then((res) => {
      if (cancelled) return;
      setRows(res.rows);
      setFailure(res.failure);
      setMessage(res.message);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, pull, scopeSubteamId, reloadKey]);

  // `rows` is the wide pull; everything below slices it. `now` is read once
  // per pull so every panel agrees on what "today" is.
  const now = useMemo(() => new Date(), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const windowRows = useMemo(
    () => (range ? sliceWindow(rows, range.from, range.to) : []),
    [rows, range],
  );
  const metrics = useMemo<ProductivityMetrics>(
    () => buildProductivity(windowRows, { now, from: range?.from, to: range?.to }),
    [windowRows, now, range],
  );
  const previousMetrics = useMemo<ProductivityMetrics | null>(() => {
    if (!range) return null;
    const prev = previousRange(range, preset);
    return buildProductivity(sliceWindow(rows, prev.from, prev.to), { now, from: prev.from, to: prev.to });
  }, [rows, range, preset, now]);
  const deltas = useMemo<WindowDeltas>(() => windowDeltas(metrics, previousMetrics), [metrics, previousMetrics]);
  // The Weeks strip always shows at least STRIP_MIN_WEEKS columns: a one-week
  // window still gets trailing context, drawn faded and excluded from every
  // number on the page.
  const strip = useMemo(() => {
    if (!range) return null;
    const contextFrom = isoWeekStart(range.to);
    contextFrom.setDate(contextFrom.getDate() - 7 * (STRIP_MIN_WEEKS - 1));
    const from = new Date(Math.min(range.from.getTime(), contextFrom.getTime()));
    return {
      metrics: buildProductivity(sliceWindow(rows, from, range.to), { now, from, to: range.to }),
      windowStart: localDayKey(isoWeekStart(range.from)),
    };
  }, [rows, range, now]);
  const state = useMemo<StateCounts>(() => stateCounts(rows, now), [rows, now]);
  // Gate mirror: the server nulls every actor unless the caller holds
  // pm.manage_dashboard in scope. Read off the WIDE pull, so a quiet week does
  // not hide the Person toggle from someone who is allowed to see it.
  const actorsAvailable = useMemo(() => {
    // v3 states the verdict on every row; a v2 server leaves it null and we
    // fall back to "did any actor come back", as before.
    const stated = rows.find((r) => r.may_see_actors !== null)?.may_see_actors;
    return stated ?? rows.some((r) => r.actor_id !== null);
  }, [rows]);
  const attention = useMemo<AttentionLists>(() => attentionLists(rows, now), [rows, now]);
  const teams = useMemo<SubteamSummary[]>(() => subteamSummaries(rows, metrics, now), [rows, metrics, now]);
  const load = useMemo<Workload>(() => workload(rows, windowRows, now), [rows, windowRows, now]);
  // Directory first; the history's own actor names (gated, so only present
  // when the caller may see people) fill in anyone the directory has not
  // synced yet.
  const usersById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.actor_id && r.actor_name) m.set(r.actor_id, r.actor_name);
    for (const u of users) m.set(u.id, u.name);
    return m;
  }, [users, rows]);
  const userName = useCallback(
    (id: string) => usersById.get(id) ?? "Unknown member",
    [usersById],
  );
  const selectTask = usePmStore((s) => s.selectTask);
  const subteamById = useMemo(() => new Map(subteams.map((s) => [s.id, s])), [subteams]);
  const rangeCaption = range
    ? `${range.from.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${range.to.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : null;
  const spark = useMemo(
    () => (range ? weeklyCompletions(rows, { weeks: SPARK_WEEKS, endingAt: range.to }) : []),
    [rows, range],
  );

  // Every number links into the Table with the matching filters. Inside a
  // subteam route the Table is already scoped; at project scope a picked
  // subteam travels along as a hide-others team filter.
  const tableHref = useCallback(
    (patch: Partial<TaskFilters>) => {
      const filters: TaskFilters = {
        ...EMPTY_FILTERS,
        ...(routeTeam || !pickedSubteamId ? {} : { subteamIds: [pickedSubteamId], showMode: "hide" as const }),
        ...patch,
      };
      const qs = filtersToParams(filters, { key: "due_date", dir: "asc" }).toString();
      const base = viewHref("table", teamSlug);
      return qs ? `${base}?${qs}` : base;
    },
    [routeTeam, pickedSubteamId, teamSlug],
  );

  // The house picker: swatch dots in each subteam's colour, keyboard nav, and a
  // portal menu — so WebView2 never paints a native (white) popup list.
  const subteamOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: "", label: "All subteams" },
      ...subteams.map((s) => ({ value: s.id, label: s.name, swatch: s.color ?? tc("dim") })),
    ],
    [subteams],
  );

  // Series colour by subteam ID (never by name), with the chips' grey fallback.
  const subteamColor = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of subteams) if (s.color) byId.set(s.id, s.color);
    return byId;
  }, [subteams]);

  const exportCsv = useCallback(async () => {
    if (!range) return;
    setExportError(null);
    try {
      // The SELECTED window's events, not the wide pull behind the sparklines.
      const csv = taskHistoryToCsv(windowRows);
      const path = await save({
        defaultPath: taskHistoryFileName(scopeLabel, toDayInput(range.from), toDayInput(range.to)),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [range, windowRows, scopeLabel]);

  // The CSV drops the synthetic `open` snapshot rows, so a window whose only
  // rows are open tasks has nothing to export even though `rows` is non-empty.
  const exportableCount = useMemo(() => countExportableEvents(windowRows), [windowRows]);

  const headerDescription = loading
    ? "Loading history…"
    : failure
      ? "History unavailable"
      : `${metrics.totalCompleted} completed in window · ${state.open} open · ${state.overdue} overdue`;

  return (
    <>
      <ViewHeader
        title={routeTeam ? `${routeTeam.name} · Productivity` : "Productivity"}
        description={headerDescription}
        actions={
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={loading || failure !== null || exportableCount === 0}
            className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-black hover:bg-asu-gold/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-helios-line bg-helios-panel/20 px-6 py-3">
        <SegmentedControl
          value={preset}
          onChange={setPreset}
          options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
          ariaLabel="Date range"
        />
        {rangeCaption ? (
          <span className="font-mono text-[11px] tabular-nums text-helios-dim" aria-label="Selected window">
            {rangeCaption}
          </span>
        ) : null}

        {preset === "custom" ? (
          <div className="flex items-end gap-2">
            <FilterField label="From">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className={filterInput}
              />
            </FilterField>
            <FilterField label="To">
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className={filterInput}
              />
            </FilterField>
          </div>
        ) : null}

        {routeTeam ? null : (
          // The Select trigger is w-full; box it so it sits inline with the pills.
          <div className="w-44">
            <Select
              value={pickedSubteamId ?? ""}
              onChange={(v) => setPickedSubteamId(v || null)}
              options={subteamOptions}
              size="sm"
              ariaLabel="Subteam"
            />
          </div>
        )}

        {actorsAvailable ? (
          <SegmentedControl
            value={showPeople ? "person" : "team"}
            onChange={(v) => setShowPeople(v === "person")}
            options={[
              { value: "team", label: "Team" },
              { value: "person", label: "Person" },
            ]}
            ariaLabel="Stack by"
            className="ml-auto"
          />
        ) : null}
      </div>

      <div ref={scrollMemRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {range === null ? (
          <Notice>Pick a valid date range — the end date must not be before the start.</Notice>
        ) : loading ? (
          <LoadingSkeleton showSubteams={!routeTeam} />
        ) : failure === "unavailable" ? (
          <Notice>
            Task history isn’t available on this server yet. The database migration that adds it
            hasn’t been applied — ask an admin to apply it, then reopen this view.
          </Notice>
        ) : failure === "error" ? (
          <Notice>
            <span className="block">Couldn’t load task history.</span>
            {message ? <span className="block text-xs opacity-70">{message}</span> : null}
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 rounded border border-helios-line px-3 py-1.5 text-sm text-helios-dim hover:bg-helios-base hover:text-helios-text"
            >
              Retry
            </button>
          </Notice>
        ) : rows.length === 0 ? (
          <Notice>Nothing here yet — no open tasks in this scope and no activity in this window.</Notice>
        ) : (
          <div className="flex flex-col gap-6">
            {exportError ? (
              <p className="text-xs text-red-400">Export failed: {exportError}</p>
            ) : null}

            <KpiRow
              metrics={metrics}
              deltas={deltas}
              state={state}
              spark={spark.map((w) => w.completed)}
              compare={compareLabel(preset, range)}
              now={now}
              tableHref={tableHref}
            />

            {strip ? (
              <ThroughputPanel
                metrics={strip.metrics}
                windowStart={strip.windowStart}
                byPerson={showPeople && actorsAvailable}
                subteamColor={(id) => subteamColor.get(id) ?? null}
                today={now}
                milestones={milestones}
                userName={userName}
              />
            ) : null}
            <div className="grid gap-6 xl:grid-cols-2">
              <AttentionPanel
                lists={attention}
                now={now}
                tableHref={tableHref}
                subteamById={subteamById}
                onOpenTask={selectTask}
              />
              <div className="flex flex-col gap-6">
                {routeTeam ? null : (
                  <SubteamsPanel teams={teams} subteamById={subteamById} tableHref={tableHref} />
                )}
                <WorkloadPanel
                  load={load}
                  gated={actorsAvailable}
                  currentUserId={currentUserId}
                  userName={userName}
                  tableHref={tableHref}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// --- shared chrome ----------------------------------------------------------

/**
 * Loading = the page's own shape in .helios-skeleton blocks (the shell's
 * shimmer, styles.css), so the layout does not jump when the numbers land.
 * Mirrors the real grid: four tiles, the Weeks strip, then Attention beside
 * Subteams + Workload.
 */
function Bone({ className }: { className: string }) {
  return <div className={`helios-skeleton rounded-md ${className}`} aria-hidden />;
}

function BonePanel({ rows, rowClass }: { rows: number; rowClass: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-helios-line bg-helios-panel p-5">
      <Bone className="h-2.5 w-20" />
      {Array.from({ length: rows }, (_, i) => (
        <Bone key={i} className={rowClass} />
      ))}
    </div>
  );
}

function LoadingSkeleton({ showSubteams }: { showSubteams: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading task history" className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-3 rounded-md border border-helios-line bg-helios-panel p-4">
            <Bone className="h-2.5 w-20" />
            <Bone className="h-8 w-16" />
            <Bone className="h-2.5 w-32" />
          </div>
        ))}
      </div>
      <BonePanel rows={1} rowClass="h-[200px] w-full" />
      <div className="grid gap-6 xl:grid-cols-2">
        <BonePanel rows={5} rowClass="h-6 w-full" />
        <div className="flex flex-col gap-6">
          {showSubteams ? <BonePanel rows={3} rowClass="h-4 w-full" /> : null}
          <BonePanel rows={3} rowClass="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-helios-line bg-helios-panel p-8 text-center text-helios-dim">
      {children}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-helios-line bg-helios-panel p-5">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-widest text-helios-dim">{title}</h3>
        {subtitle ? <p className="mt-1 text-xs text-helios-dim/70">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

// --- panels -----------------------------------------------------------------

const NO_SUBTEAM_COLOR = tc("dim");

/** The Monday..Sunday window that contains `now`, as due-date filter bounds. */
function thisWeekBounds(now: Date): { from: string; to: string } {
  const mon = isoWeekStart(now);
  const sun = new Date(mon.getTime());
  sun.setDate(sun.getDate() + 6);
  return { from: localDayKey(now), to: localDayKey(sun) };
}

// --- attention --------------------------------------------------------------

const ATTENTION_PREVIEW = 5;

interface AttentionSection {
  key: string;
  title: string;
  hint: string;
  items: AttentionItem[];
  href: string;
  /** Right-hand meta for one row. */
  meta: (item: AttentionItem) => string;
}

function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function dayCount(n: number | null, suffix = ""): string {
  if (n === null) return "—";
  return `${n} d${suffix}`;
}

function AttentionPanel({
  lists,
  now,
  tableHref,
  subteamById,
  onOpenTask,
}: {
  lists: AttentionLists;
  now: Date;
  tableHref: (patch: Partial<TaskFilters>) => string;
  subteamById: Map<string, Subteam>;
  onOpenTask: (id: string) => void;
}) {
  const week = thisWeekBounds(now);
  const yesterday = new Date(now.getTime() - MS_PER_DAY);
  const sections: AttentionSection[] = [
    {
      key: "overdue",
      title: "Overdue",
      hint: "open, past due — most recently slipped first",
      items: lists.overdue,
      href: tableHref({ status: [...OPEN_STATUSES], dueTo: localDayKey(yesterday) }),
      meta: (i) => dayCount(i.days, " late"),
    },
    {
      key: "due",
      title: "Due this week",
      hint: "open, due by Sunday",
      items: lists.dueThisWeek,
      href: tableHref({ status: [...OPEN_STATUSES], dueFrom: week.from, dueTo: week.to }),
      meta: (i) => (i.days === 0 ? "today" : i.dueDate ? shortDate(i.dueDate) : "—"),
    },
    {
      key: "review",
      title: lists.agesKnown ? "Waiting on review > 7 d" : "Waiting on review",
      hint: lists.agesKnown ? "needs review for more than a week" : "needs review",
      items: lists.needsReview,
      href: tableHref({ status: ["needs_review"] }),
      meta: (i) => dayCount(i.days),
    },
    {
      key: "blocked",
      title: "Blocked",
      hint: "longest blocked first",
      items: lists.blocked,
      href: tableHref({ status: ["blocked"] }),
      meta: (i) => dayCount(i.days),
    },
    {
      key: "stale",
      title: lists.agesKnown ? "In progress, untouched 14 d" : "In progress",
      hint: lists.agesKnown ? "no change in two weeks or more" : "ages need the latest server update",
      items: lists.stale,
      href: tableHref({ status: ["in_progress"] }),
      meta: (i) => dayCount(i.days),
    },
  ];
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <Panel title="Attention" subtitle="What a lead chases this week. Click a task to open it; each heading opens the full list in the Table.">
      {total === 0 ? (
        <Empty>Nothing overdue, stuck or stale. Enjoy it.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {sections.map((s) => (
            <section key={s.key} aria-label={s.title} className="flex flex-col gap-1">
              <Link
                href={s.href}
                className="group flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs hover:bg-helios-base"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-medium text-helios-text">{s.title}</span>
                  <span className="truncate text-helios-dim/70">{s.hint}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`font-mono text-sm tabular-nums ${s.items.length > 0 ? "text-helios-text" : "text-helios-dim/60"}`}
                  >
                    {s.items.length}
                  </span>
                  <IconArrowRight
                    size={12}
                    strokeWidth={1.5}
                    aria-hidden
                    className="text-helios-dim opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </span>
              </Link>
              {s.items.length > 0 ? (
                <ul className="flex flex-col">
                  {s.items.slice(0, ATTENTION_PREVIEW).map((item) => {
                    const st = subteamById.get(item.subteamId ?? "");
                    return (
                      <li key={item.taskId}>
                        <button
                          type="button"
                          onClick={() => onOpenTask(item.taskId)}
                          className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-helios-base"
                        >
                          <span
                            aria-hidden
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: STATUS_DOT[item.status as TaskStatus] ?? tc("dim") }}
                          />
                          <span className="min-w-0 flex-1 truncate text-helios-text">{item.title}</span>
                          {st ? (
                            <span
                              className="shrink-0 rounded-full border px-1.5 text-[10px] leading-4"
                              style={{ borderColor: `${st.color ?? NO_SUBTEAM_COLOR}80`, color: st.color ?? NO_SUBTEAM_COLOR }}
                            >
                              {st.code}
                            </span>
                          ) : null}
                          <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-helios-dim">
                            {s.meta(item)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {s.items.length > ATTENTION_PREVIEW ? (
                    <li>
                      <Link
                        href={s.href}
                        className="block px-1 py-1 text-[11px] text-helios-dim hover:text-helios-text"
                      >
                        + {s.items.length - ATTENTION_PREVIEW} more in the Table
                      </Link>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

// --- subteams ---------------------------------------------------------------

/** The status mix of a row as bar segments, in the order the bar reads. */
function statusSegments(s: {
  done: number;
  inProgress: number;
  needsReview: number;
  blocked: number;
  notStarted: number;
}): BarSegment[] {
  return [
    { key: "done", label: STATUS_LABEL.done, value: s.done, color: STATUS_DOT.done },
    { key: "in_progress", label: STATUS_LABEL.in_progress, value: s.inProgress, color: STATUS_DOT.in_progress },
    { key: "needs_review", label: STATUS_LABEL.needs_review, value: s.needsReview, color: STATUS_DOT.needs_review },
    { key: "blocked", label: STATUS_LABEL.blocked, value: s.blocked, color: STATUS_DOT.blocked },
    { key: "not_started", label: STATUS_LABEL.not_started, value: s.notStarted, color: STATUS_DOT.not_started },
  ];
}

const COL = "w-14 whitespace-nowrap text-right";

function Num({ value, tone = "dim" }: { value: string | number; tone?: "dim" | "text" | "warn" | "danger" }) {
  const cls =
    tone === "danger"
      ? "text-helios-danger"
      : tone === "warn"
        ? "text-helios-warn"
        : tone === "text"
          ? "text-helios-text"
          : "text-helios-dim";
  return <span className={`${COL} ${cls}`}>{value}</span>;
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function SubteamsPanel({
  teams,
  subteamById,
  tableHref,
}: {
  teams: SubteamSummary[];
  subteamById: Map<string, Subteam>;
  tableHref: (patch: Partial<TaskFilters>) => string;
}) {
  const max = Math.max(1, ...teams.map((t) => t.open + t.done));
  return (
    <Panel
      title="Subteams"
      subtitle="Open work by status, with this window's completions. Stuck first. A name opens that subteam in the Table."
    >
      {teams.length === 0 ? (
        <Empty>No open or completed work in this scope.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-helios-dim">
            <span className="w-36 shrink-0" />
            <span className="min-w-0 flex-1" />
            <span className="flex shrink-0 gap-3">
              <span className={COL}>done</span>
              <span className={COL}>stuck</span>
              <span className={COL}>late</span>
              <span className={COL}>on time</span>
            </span>
          </div>
          {teams.map((t) => {
            const st = subteamById.get(t.subteamId);
            const color = st?.color ?? NO_SUBTEAM_COLOR;
            return (
              <BarStrip
                key={t.subteamId || "__none__"}
                title={t.subteamName}
                max={max}
                segments={statusSegments(t)}
                label={
                  t.subteamId ? (
                    <Link
                      href={tableHref({ subteamIds: [t.subteamId], showMode: "hide" })}
                      className="inline-flex max-w-full items-center gap-1.5 text-helios-text hover:underline"
                    >
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span className="truncate">{t.subteamName}</span>
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-helios-dim">
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      {t.subteamName}
                    </span>
                  )
                }
                trailing={
                  <>
                    <Num value={t.done} tone={t.done > 0 ? "text" : "dim"} />
                    <Num value={t.stuck} tone={t.stuck > 0 ? "danger" : "dim"} />
                    <Num value={t.overdue} tone={t.overdue > 0 ? "warn" : "dim"} />
                    <Num value={pct(t.onTimeRate)} tone={t.onTimeRate === null ? "dim" : "text"} />
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function KpiRow({
  metrics,
  deltas,
  state,
  spark,
  compare,
  now,
  tableHref,
}: {
  metrics: ProductivityMetrics;
  deltas: WindowDeltas;
  state: StateCounts;
  spark: number[];
  compare: string;
  now: Date;
  tableHref: (patch: Partial<TaskFilters>) => string;
}) {
  const week = thisWeekBounds(now);
  const todayIndex = (now.getDay() + 6) % 7;
  const onTime = deltas.onTimePct.value;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        label="Completed"
        value={deltas.completed.value}
        sub={
          deltas.completed.value === 0
            ? "Nothing finished yet in this window"
            : `${metrics.subteams.length} subteam${metrics.subteams.length === 1 ? "" : "s"} contributed`
        }
        compare={<Delta delta={deltas.completed.delta} label={compare} />}
        chart={<Sparkline values={spark} label={`Completions over the last ${spark.length} weeks`} />}
        href={tableHref({ status: ["done"] })}
        linkLabel="Open completed tasks in the Table"
      />
      <KpiTile
        label="Due this week"
        value={state.dueThisWeek}
        sub={`${state.overdue} already overdue · ${state.noDueDate} with no due date`}
        chart={<DayStrip values={state.dueByDay} todayIndex={todayIndex} label="Open tasks due each day this week" />}
        href={tableHref({ status: [...OPEN_STATUSES], dueFrom: week.from, dueTo: week.to })}
        linkLabel="Open tasks due this week in the Table"
        tone={state.dueThisWeek > 0 ? "warn" : "neutral"}
      />
      <KpiTile
        label="Stuck"
        value={state.stuck}
        sub={`${state.blocked} blocked · ${state.needsReview} waiting on review`}
        href={tableHref({ status: ["blocked", "needs_review"] })}
        linkLabel="Open blocked and needs-review tasks in the Table"
        tone={state.stuck > 0 ? "danger" : "neutral"}
      />
      <KpiTile
        label="On time"
        value={onTime === null ? "—" : `${onTime}%`}
        sub={
          metrics.onTime.considered === 0
            ? "No completions with a due date in this window"
            : `${metrics.onTime.onTime} of ${metrics.onTime.considered} with a due date · ${metrics.onTime.excludedNoDueDate} had none`
        }
        compare={<Delta delta={deltas.onTimePct.delta} label={compare} unit=" pts" />}
        // A due-from at the epoch is how the Table says "has a due date".
        href={tableHref({ status: ["done"], dueFrom: "2000-01-01" })}
        linkLabel="Open completed tasks with a due date in the Table"
      />
    </div>
  );
}

const MILESTONE_KIND: Record<Milestone["type"], string> = {
  design_review: "design review",
  integration: "integration",
  validation: "validation",
  gate: "gate",
  comp_event: "competition event",
};

/** "CDR in 31 d" — the next milestone on or after today, or null. */
function nextMilestone(milestones: ReadonlyArray<Milestone>, today: Date): { name: string; days: number } | null {
  const todayKey = localDayKey(today);
  const upcoming = milestones
    .filter((m) => m.target_date >= todayKey)
    .sort((a, b) => a.target_date.localeCompare(b.target_date))[0];
  if (!upcoming) return null;
  const [y, mo, d] = upcoming.target_date.split("-").map(Number);
  if (!y || !mo || !d) return null;
  const days = Math.round((new Date(y, mo - 1, d).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / MS_PER_DAY);
  return { name: upcoming.name, days };
}

function ThroughputPanel({
  metrics,
  byPerson,
  subteamColor,
  today,
  milestones,
  windowStart,
  userName,
}: {
  /** The STRIP's metrics: the window plus trailing context weeks. */
  metrics: ProductivityMetrics;
  byPerson: boolean;
  subteamColor: (id: string) => string | null;
  today: Date;
  milestones: ReadonlyArray<Milestone>;
  /** Monday (YYYY-MM-DD) of the selected window's first week; earlier columns are context. */
  windowStart: string;
  /** Owner id -> display name, for Person stacking. */
  userName: (id: string) => string;
}) {
  const weeks = metrics.throughput;
  const currentKey = isoWeekKey(today);
  const hasContext = weeks.some((w) => w.weekStart < windowStart);
  // Diamonds on the baseline for every milestone inside the strip's weeks;
  // ChartFrame drops the ones outside. The caption names the next one so the
  // strip still says something when nothing falls in range.
  const markers: FrameMilestone[] = milestones.map((m) => ({
    id: m.id,
    name: m.name,
    day: m.target_date,
    kind: MILESTONE_KIND[m.type],
  }));
  const next = nextMilestone(milestones, today);
  const series: WeekSeries[] = byPerson
    ? [...new Set(weeks.flatMap((w) => Object.keys(w.byPerson)))]
        .map((id) => ({ id, label: id === "" ? "Unowned" : userName(id), color: id === "" ? NO_SUBTEAM_COLOR : personColor(id) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : metrics.subteams.map((s) => ({
        id: s.id,
        label: s.name,
        color: subteamColor(s.id) ?? NO_SUBTEAM_COLOR,
      }));
  const columns: WeekColumn[] = weeks.map((w) => ({
    key: w.week,
    weekStart: w.weekStart,
    values: byPerson ? w.byPerson : w.bySubteam,
    total: w.completed,
    inWindow: w.weekStart >= windowStart,
    isCurrent: w.week === currentKey,
  }));

  return (
    <Panel
      title="Weeks"
      subtitle={
        `Tasks completed per ISO week, stacked by ${byPerson ? "person" : "subteam"}. Hover a week for the split; diamonds are milestones.` +
        (hasContext ? " Faded weeks are before the window." : "") +
        (next ? ` Next: ${next.name} ${next.days === 0 ? "today" : `in ${next.days} d`}.` : "")
      }
    >
      {columns.length === 0 ? (
        <Empty>No completions in this window.</Empty>
      ) : (
        <StackedWeeks
          columns={columns}
          series={series}
          milestones={markers}
          ariaLabel="Tasks completed per week"
        />
      )}
    </Panel>
  );
}

// People have no colour of their own. Derive a stable hue from the owner id so
// a person keeps their colour across windows and reloads — an index-based
// palette would reshuffle everyone whenever the set of people changed.
function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 60%)`;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-helios-dim">{children}</p>;
}

// --- workload ---------------------------------------------------------------

const WORKLOAD_PREVIEW = 12;

/**
 * Workload balance: open work per owner, Unowned as a first-class row, sorted
 * by open + due soon — never by completions. Gated like every person-level
 * surface: without pm.manage_dashboard in scope only the caller's own row and
 * the Unowned pile are shown, so a member can still see what they carry and
 * what nobody has picked up.
 */
function WorkloadPanel({
  load,
  gated,
  currentUserId,
  userName,
  tableHref,
}: {
  load: Workload;
  /** True when the caller may see other people's rows. */
  gated: boolean;
  currentUserId: string;
  userName: (id: string) => string;
  tableHref: (patch: Partial<TaskFilters>) => string;
}) {
  if (!load.ownersKnown) {
    return (
      <Panel title="Workload">
        <Empty>Workload needs the latest server update (task owners are not in this history yet).</Empty>
      </Panel>
    );
  }
  const visible = gated
    ? load.rows
    : load.rows.filter((r) => r.ownerId === "" || r.ownerId === currentUserId);
  const hidden = load.rows.length - visible.length;
  const max = Math.max(1, ...load.rows.map((r) => r.open + r.done));
  const shown = visible.slice(0, WORKLOAD_PREVIEW);

  return (
    <Panel
      title="Workload"
      subtitle={
        gated
          ? "Open work per owner, most loaded first. Balance, not a scoreboard. A name opens their tasks in the Table."
          : "Your own row and the unowned pile. Other people's rows are only visible to people who can manage this scope's dashboard."
      }
    >
      {visible.length === 0 ? (
        <Empty>No open work in this scope.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-helios-dim">
            <span className="w-36 shrink-0" />
            <span className="min-w-0 flex-1" />
            <span className="flex shrink-0 gap-3">
              <span className={COL}>open</span>
              <span className={COL}>due 7d</span>
              <span className={COL}>late</span>
              <span className={COL}>done</span>
            </span>
          </div>
          {shown.map((r) => {
            const isSelf = r.ownerId !== "" && r.ownerId === currentUserId;
            const name = r.ownerId === "" ? "Unowned" : userName(r.ownerId);
            return (
              <BarStrip
                key={r.ownerId || "__unowned__"}
                title={name}
                max={max}
                emphasis={isSelf}
                segments={statusSegments(r)}
                label={
                  <Link
                    href={tableHref({ ownerIds: [r.ownerId === "" ? "__unassigned__" : r.ownerId] })}
                    className={`inline-flex max-w-full items-center gap-1.5 hover:underline ${
                      r.ownerId === "" ? "text-helios-dim" : "text-helios-text"
                    }`}
                  >
                    <span className="truncate">{name}</span>
                    {isSelf ? <span className="shrink-0 text-[10px] text-asu-gold">you</span> : null}
                  </Link>
                }
                trailing={
                  <>
                    <Num value={r.open} tone="text" />
                    <Num value={r.dueSoon} tone={r.dueSoon > 0 ? "warn" : "dim"} />
                    <Num value={r.overdue} tone={r.overdue > 0 ? "danger" : "dim"} />
                    <Num value={r.done} tone={r.done > 0 ? "text" : "dim"} />
                  </>
                }
              />
            );
          })}
          {visible.length > shown.length ? (
            <p className="text-[11px] text-helios-dim">
              + {visible.length - shown.length} more with open work — the Table's Owner filter lists everyone.
            </p>
          ) : null}
          {hidden > 0 ? (
            <p className="text-[11px] text-helios-dim">
              {hidden} other {hidden === 1 ? "person's row is" : "people's rows are"} hidden.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
