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
import { STATUS_DOT, type Subteam, type TaskStatus } from "@helios/pm-ui";
import { Link } from "@pm/lib/router";
import {
  attentionLists,
  buildProductivity,
  isoWeekKey,
  isoWeekStart,
  localDayKey,
  sliceWindow,
  stateCounts,
  weeklyCompletions,
  windowDeltas,
  type AttentionItem,
  type AttentionLists,
  type ProductivityMetrics,
  type StateCounts,
  type WindowDeltas,
} from "@pm/lib/productivityMetrics";
import { StackedWeeks, type WeekColumn, type WeekSeries } from "@pm/components/charts/StackedWeeks";
import { KpiTile } from "@pm/components/charts/KpiTile";
import { Delta } from "@pm/components/charts/Delta";
import { Sparkline } from "@pm/components/charts/Sparkline";
import { DayStrip } from "@pm/components/charts/DayStrip";
import {
  countExportableEvents,
  taskHistoryFileName,
  taskHistoryToCsv,
} from "@pm/lib/taskHistoryCsv";

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

interface Range {
  from: Date;
  to: Date;
}

/** The window of the same length that ends the instant before `r` starts. */
function previousRange(r: Range): Range {
  const len = r.to.getTime() - r.from.getTime();
  const to = new Date(r.from.getTime() - 1);
  return { from: new Date(to.getTime() - len), to };
}

/**
 * ONE RPC pull feeds three readings: the selected window, the previous window
 * (deltas) and the trailing twelve weeks (sparklines and the Weeks strip's
 * context columns). Fetching the union and slicing client-side is cheaper than
 * three round trips and gives one loading state instead of three.
 */
function fetchRange(r: Range): Range {
  const prev = previousRange(r);
  const context = isoWeekStart(r.to);
  context.setDate(context.getDate() - 7 * (SPARK_WEEKS - 1));
  const from = new Date(Math.min(prev.from.getTime(), context.getTime()));
  return { from, to: r.to };
}

function compareLabel(key: PresetKey, r: Range): string {
  if (key === "week") return "vs last week";
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

  const pull = useMemo(() => (range ? fetchRange(range) : null), [range]);

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
    const prev = previousRange(range);
    return buildProductivity(sliceWindow(rows, prev.from, prev.to), { now, from: prev.from, to: prev.to });
  }, [rows, range, now]);
  const deltas = useMemo<WindowDeltas>(() => windowDeltas(metrics, previousMetrics), [metrics, previousMetrics]);
  const state = useMemo<StateCounts>(() => stateCounts(rows, now), [rows, now]);
  // Gate mirror: the server nulls every actor unless the caller holds
  // pm.manage_dashboard in scope. Read off the WIDE pull, so a quiet week does
  // not hide the Person toggle from someone who is allowed to see it.
  const actorsAvailable = useMemo(() => rows.some((r) => r.actor_id !== null), [rows]);
  const attention = useMemo<AttentionLists>(() => attentionLists(rows, now), [rows, now]);
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
      ...subteams.map((s) => ({ value: s.id, label: s.name, swatch: s.color ?? "#6B7280" })),
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
          <Select
            value={pickedSubteamId ?? ""}
            onChange={(v) => setPickedSubteamId(v || null)}
            options={subteamOptions}
            size="sm"
            ariaLabel="Subteam"
            className="min-w-[160px]"
          />
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
          <Notice>Loading task history…</Notice>
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
          <Notice>No task activity in this window.</Notice>
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

            <ThroughputPanel
              metrics={metrics}
              byPerson={showPeople && actorsAvailable}
              subteamColor={(id) => subteamColor.get(id) ?? null}
              today={now}
            />
            <AttentionPanel
              lists={attention}
              now={now}
              tableHref={tableHref}
              subteamById={subteamById}
              onOpenTask={selectTask}
            />
            <BurnupPanel metrics={metrics} />
            <div className="grid gap-6 lg:grid-cols-2">
              <CycleTimePanel metrics={metrics} />
              <div className="flex flex-col gap-6">
                <OnTimePanel metrics={metrics} />
                <AgingPanel metrics={metrics} />
              </div>
            </div>
            <PeoplePanel metrics={metrics} />
          </div>
        )}
      </div>
    </>
  );
}

// --- shared chrome ----------------------------------------------------------

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

const NO_SUBTEAM_COLOR = "#6B7280";

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
                            style={{ backgroundColor: STATUS_DOT[item.status as TaskStatus] ?? "#9097A0" }}
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
                          <span className="w-14 shrink-0 text-right font-mono tabular-nums text-helios-dim">
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
        sub={`${metrics.subteams.length} subteam${metrics.subteams.length === 1 ? "" : "s"} contributed`}
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

function ThroughputPanel({
  metrics,
  byPerson,
  subteamColor,
  today,
}: {
  metrics: ProductivityMetrics;
  byPerson: boolean;
  subteamColor: (id: string) => string | null;
  today: Date;
}) {
  const weeks = metrics.throughput;
  const currentKey = isoWeekKey(today);
  const series: WeekSeries[] = byPerson
    ? [...new Set(weeks.flatMap((w) => Object.keys(w.byPerson)))]
        .sort()
        .map((name) => ({ id: name, label: name, color: personColor(name) }))
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
    inWindow: true,
    isCurrent: w.week === currentKey,
  }));

  return (
    <Panel
      title="Weeks"
      subtitle={`Tasks completed per ISO week, stacked by ${byPerson ? "person" : "subteam"}. Hover a week for the split.`}
    >
      {columns.length === 0 ? (
        <Empty>No completions in this window.</Empty>
      ) : (
        <StackedWeeks columns={columns} series={series} ariaLabel="Tasks completed per week" />
      )}
    </Panel>
  );
}

// People have no colour of their own. Derive a stable hue from the name so a
// person keeps their colour across windows and reloads — an index-based
// palette would reshuffle everyone whenever the set of names changed.
function personColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 60%)`;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-helios-dim">{children}</p>;
}

// Scaled-viewBox constants, only the burn-up still uses them (it goes next).
const CHART_W = 760;
const CHART_H = 200;
const PAD_L = 34;
const PAD_B = 22;

function BurnupPanel({ metrics }: { metrics: ProductivityMetrics }) {
  const pts = metrics.burnup;
  const max = Math.max(1, ...pts.map((p) => p.createdCumulative));
  const plotH = CHART_H - PAD_B;
  const x = (i: number) => PAD_L + (pts.length > 1 ? (i / (pts.length - 1)) * (CHART_W - PAD_L) : 0);
  const y = (v: number) => plotH - (v / max) * (plotH - 8);
  const path = (get: (p: (typeof pts)[number]) => number) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");

  return (
    <Panel title="Created vs completed" subtitle="Cumulative over the window.">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        role="img"
        aria-label="Cumulative created versus completed"
      >
        <line x1={PAD_L} y1={plotH} x2={CHART_W} y2={plotH} stroke="currentColor" opacity={0.2} />
        <text x={2} y={12} className="fill-current text-[10px] opacity-50">
          {max}
        </text>
        <path d={path((p) => p.createdCumulative)} fill="none" stroke="#8C1D40" strokeWidth={2} />
        <path d={path((p) => p.completedCumulative)} fill="none" stroke="#FFC627" strokeWidth={2} />
      </svg>
      <ul className="flex gap-4 text-xs text-helios-dim">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: "#8C1D40" }} />
          Created ({metrics.totalCreated})
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: "#FFC627" }} />
          Completed ({metrics.totalCompleted})
        </li>
      </ul>
    </Panel>
  );
}

function days(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)} d`;
}

function CycleTimePanel({ metrics }: { metrics: ProductivityMetrics }) {
  const maxBucket = Math.max(1, ...metrics.cycleHistogram.map((b) => b.count));
  return (
    <Panel
      title="Cycle time"
      subtitle="Days from task creation to its last completion."
    >
      <p className="text-sm text-helios-text">
        Median {days(metrics.cycleTimeOverall.median)} · p85 {days(metrics.cycleTimeOverall.p85)}{" "}
        <span className="text-helios-dim">({metrics.cycleTimeOverall.n} tasks)</span>
      </p>

      <div className="flex flex-col gap-1.5">
        {metrics.cycleHistogram.map((b) => (
          <div key={b.label} className="flex items-center gap-2 text-xs text-helios-dim">
            <span className="w-14 shrink-0 text-right">{b.label}</span>
            <span className="h-3 flex-1 overflow-hidden rounded-sm bg-helios-base">
              <span
                className="block h-full rounded-sm"
                style={{ width: `${(b.count / maxBucket) * 100}%`, backgroundColor: "#FFC627" }}
              />
            </span>
            <span className="w-6 shrink-0 tabular-nums">{b.count}</span>
          </div>
        ))}
      </div>

      {metrics.cycleTimeBySubteam.length > 1 ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-helios-line text-left text-[10px] uppercase tracking-widest text-helios-dim">
              <th className="py-1.5">Subteam</th>
              <th className="py-1.5 text-right">n</th>
              <th className="py-1.5 text-right">Median</th>
              <th className="py-1.5 text-right">p85</th>
            </tr>
          </thead>
          <tbody>
            {metrics.cycleTimeBySubteam.map((s) => (
              <tr key={s.subteamName} className="border-b border-helios-line/60 last:border-b-0">
                <td className="py-1.5 text-helios-text">{s.subteamName}</td>
                <td className="py-1.5 text-right tabular-nums text-helios-dim">{s.n}</td>
                <td className="py-1.5 text-right tabular-nums text-helios-dim">{days(s.median)}</td>
                <td className="py-1.5 text-right tabular-nums text-helios-dim">{days(s.p85)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

function OnTimePanel({ metrics }: { metrics: ProductivityMetrics }) {
  const { rate, onTime, considered, excludedNoDueDate } = metrics.onTime;
  return (
    <Panel title="On-time rate" subtitle="Completed on or before the due date.">
      <p className="text-2xl font-medium text-helios-text">
        {rate === null ? "—" : `${Math.round(rate * 100)}%`}
      </p>
      <p className="text-xs text-helios-dim">
        {onTime} of {considered} completed tasks with a due date.
        {excludedNoDueDate > 0
          ? ` ${excludedNoDueDate} completed task${excludedNoDueDate === 1 ? "" : "s"} had no due date and ${excludedNoDueDate === 1 ? "is" : "are"} excluded.`
          : ""}
      </p>
    </Panel>
  );
}

function AgingPanel({ metrics }: { metrics: ProductivityMetrics }) {
  const max = Math.max(1, ...metrics.aging.map((b) => b.count));
  return (
    <Panel title="Open work aging" subtitle="Currently open tasks, by age since creation.">
      <div className="flex flex-col gap-1.5">
        {metrics.aging.map((b) => (
          <div key={b.label} className="flex items-center gap-2 text-xs text-helios-dim">
            <span className="w-20 shrink-0 text-right">{b.label}</span>
            <span className="h-3 flex-1 overflow-hidden rounded-sm bg-helios-base">
              <span
                className="block h-full rounded-sm"
                style={{ width: `${(b.count / max) * 100}%`, backgroundColor: "#8C1D40" }}
              />
            </span>
            <span className="w-6 shrink-0 tabular-nums">{b.count}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PeoplePanel({ metrics }: { metrics: ProductivityMetrics }) {
  if (!metrics.actorsAvailable) {
    return (
      <Panel title="By person">
        <p className="text-sm text-helios-dim">
          Per-person numbers are only visible to people who can manage this scope’s dashboard.
        </p>
      </Panel>
    );
  }
  return (
    <Panel
      title="By person"
      subtitle="Open counts are tasks the person created — task history records who acted, not who currently owns the task."
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-helios-line text-left text-[10px] uppercase tracking-widest text-helios-dim">
            <th className="py-1.5">Person</th>
            <th className="py-1.5 text-right">Completed</th>
            <th className="py-1.5 text-right">Median cycle</th>
            <th className="py-1.5 text-right">On time</th>
            <th className="py-1.5 text-right">Open (created)</th>
          </tr>
        </thead>
        <tbody>
          {metrics.perPerson.map((p) => (
            <tr key={p.actorId} className="border-b border-helios-line/60 last:border-b-0">
              <td className="py-1.5 text-helios-text">{p.actorName}</td>
              <td className="py-1.5 text-right tabular-nums text-helios-dim">{p.completions}</td>
              <td className="py-1.5 text-right tabular-nums text-helios-dim">
                {days(p.medianCycleDays)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-helios-dim">
                {p.onTimeRate === null ? "—" : `${Math.round(p.onTimeRate * 100)}%`}
              </td>
              <td className="py-1.5 text-right tabular-nums text-helios-dim">{p.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
