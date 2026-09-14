"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useSupabaseClient } from "@helios/auth";
import { ViewHeader } from "@pm/components/ViewHeader";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { FilterField, filterInput } from "@pm/components/TaskFilterBar";
import { usePmStore } from "@pm/lib/pmStore";
import { useScrollMemory } from "@pm/lib/useScrollMemory";
import { fetchTaskHistory, type TaskHistoryFailure, type TaskHistoryRow } from "@pm/lib/taskHistory";
import {
  buildProductivity,
  type ProductivityMetrics,
  type WeekThroughput,
} from "@pm/lib/productivityMetrics";
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
  { key: "4w", label: "4 weeks", weeks: 4 },
  { key: "12w", label: "12 weeks", weeks: 12 },
  { key: "season", label: "Season to date", weeks: null },
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
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset?.weeks) return null;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - preset.weeks * 7);
  return { from, to };
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

  const [preset, setPreset] = useState<PresetKey>("12w");
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

  useEffect(() => {
    if (!projectId || !range) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void fetchTaskHistory(client, {
      projectId,
      from: range.from,
      to: range.to,
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
  }, [client, projectId, range, scopeSubteamId, reloadKey]);

  const metrics = useMemo<ProductivityMetrics>(
    () => buildProductivity(rows, { now: new Date() }),
    [rows],
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

  const subteamColor = useMemo(() => {
    const byName = new Map<string, string>();
    for (const s of subteams) if (s.color) byName.set(s.name, s.color);
    return byName;
  }, [subteams]);

  const exportCsv = useCallback(async () => {
    if (!range) return;
    setExportError(null);
    try {
      const csv = taskHistoryToCsv(rows);
      const path = await save({
        defaultPath: taskHistoryFileName(scopeLabel, toDayInput(range.from), toDayInput(range.to)),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [range, rows, scopeLabel]);

  // The CSV drops the synthetic `open` snapshot rows, so a window whose only
  // rows are open tasks has nothing to export even though `rows` is non-empty.
  const exportableCount = useMemo(() => countExportableEvents(rows), [rows]);

  const headerDescription = loading
    ? "Loading history…"
    : failure
      ? "History unavailable"
      : `${metrics.totalCompleted} completed · ${metrics.totalCreated} created · ${metrics.totalOpen} open`;

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
        <div className="flex items-center gap-1" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              aria-pressed={preset === p.key}
              className={`rounded px-2.5 py-1 text-xs ${
                preset === p.key
                  ? "bg-asu-gold/20 text-helios-text"
                  : "text-helios-dim hover:bg-helios-base hover:text-helios-text"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

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

        {metrics.actorsAvailable ? (
          <label className="flex items-center gap-1.5 text-xs text-helios-dim">
            <input
              type="checkbox"
              checked={showPeople}
              onChange={(e) => setShowPeople(e.target.checked)}
            />
            Stack by person
          </label>
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

            <ThroughputPanel
              metrics={metrics}
              byPerson={showPeople && metrics.actorsAvailable}
              colorFor={(name) => subteamColor.get(name) ?? null}
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

// A stable, readable series colour for a name with no subteam colour of its own.
const FALLBACK_COLORS = [
  "#8C1D40",
  "#FFC627",
  "#3B82F6",
  "#10B981",
  "#A855F7",
  "#F97316",
  "#14B8A6",
  "#EC4899",
];

function fallbackColor(name: string, index: number): string {
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0]!;
}

function weekLabel(w: WeekThroughput): string {
  // "Jan 12" — the Monday of the week, which reads better on an axis than W03.
  const [y, m, d] = w.weekStart.split("-").map(Number);
  if (!y || !m || !d) return w.week;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- panels -----------------------------------------------------------------

const CHART_W = 760;
const CHART_H = 200;
const PAD_L = 34;
const PAD_B = 22;

function ThroughputPanel({
  metrics,
  byPerson,
  colorFor,
}: {
  metrics: ProductivityMetrics;
  byPerson: boolean;
  colorFor: (name: string) => string | null;
}) {
  const weeks = metrics.throughput;
  const series = byPerson
    ? [...new Set(weeks.flatMap((w) => Object.keys(w.byPerson)))].sort()
    : metrics.subteamNames;
  const pick = (w: WeekThroughput) => (byPerson ? w.byPerson : w.bySubteam);
  const max = Math.max(1, ...weeks.map((w) => w.completed));
  const plotH = CHART_H - PAD_B;
  const slot = weeks.length > 0 ? (CHART_W - PAD_L) / weeks.length : 0;
  const barW = Math.max(2, slot * 0.66);

  return (
    <Panel
      title="Throughput"
      subtitle={`Tasks completed per ISO week, stacked by ${byPerson ? "person" : "subteam"}.`}
    >
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        role="img"
        aria-label="Tasks completed per week"
      >
        <line x1={PAD_L} y1={plotH} x2={CHART_W} y2={plotH} stroke="currentColor" opacity={0.2} />
        <text x={2} y={12} className="fill-current text-[10px] opacity-50">
          {max}
        </text>
        {weeks.map((w, i) => {
          const counts = pick(w);
          let yCursor = plotH;
          return (
            <g key={w.week}>
              {series.map((name, si) => {
                const n = counts[name] ?? 0;
                if (n === 0) return null;
                const h = (n / max) * (plotH - 8);
                yCursor -= h;
                return (
                  <rect
                    key={name}
                    x={PAD_L + i * slot + (slot - barW) / 2}
                    y={yCursor}
                    width={barW}
                    height={h}
                    fill={colorFor(name) ?? fallbackColor(name, si)}
                  >
                    <title>{`${name} · ${weekLabel(w)} · ${n}`}</title>
                  </rect>
                );
              })}
              {i % Math.max(1, Math.ceil(weeks.length / 12)) === 0 ? (
                <text
                  x={PAD_L + i * slot + slot / 2}
                  y={CHART_H - 6}
                  textAnchor="middle"
                  className="fill-current text-[9px] opacity-50"
                >
                  {weekLabel(w)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Legend names={series} colorFor={colorFor} />
    </Panel>
  );
}

function Legend({
  names,
  colorFor,
}: {
  names: string[];
  colorFor: (name: string) => string | null;
}) {
  if (names.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {names.map((n, i) => (
        <li key={n} className="flex items-center gap-1.5 text-xs text-helios-dim">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: colorFor(n) ?? fallbackColor(n, i) }}
          />
          {n}
        </li>
      ))}
    </ul>
  );
}

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
