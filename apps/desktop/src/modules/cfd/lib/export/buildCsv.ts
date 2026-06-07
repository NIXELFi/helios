// Pure CSV builders for every CFD study kind. No React, no Tauri — strings in,
// a CSV string out, so each builder is trivially unit-testable. Shared rules:
//   * two header rows — column names, then units (csv-export.ts idiom)
//   * csvCell() quoting for any cell containing quote/comma/newline
//   * non-finite numbers render as an EMPTY cell (never NaN/Infinity text)
//   * rows joined with "\n"
// Column names/units/decimals come from metricMeta so headers stay in sync
// with the chart + objective vocabulary across the module.

import type {
  CycleStats,
  OptimizationStudy,
  ParameterMeta,
  SingleRpmStudy,
  SweepStudy,
} from "../../state/types";
import { CYCLE_METRICS, objectiveUnit } from "../metricMeta";
import { rankTrials } from "../analytics/optimizationStats";

/** Quote a cell when it contains a CSV-special character. csv-export idiom. */
function csvCell(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Format a number to `decimals`, or empty string when non-finite. The empty
 *  cell is deliberate — old persisted studies and pending trials carry holes
 *  we never want to serialize as "NaN".
 *
 *  Magnitudes that toFixed would flatten to 0 (|v| < 10^-decimals — e.g. a
 *  ~1e-7 nonconservation objective, or the kg-scale mass-drift columns the
 *  screens render via toExponential) fall back to exponential so the file
 *  matches what the screen shows instead of lying "0.000000". */
function num(v: number | null | undefined, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return "";
  if (Object.is(v, -0)) v = 0; // avoid the "-0.000000" signed-zero artifact
  const d = Math.max(0, Math.min(8, decimals));
  if (v !== 0 && Math.abs(v) < Math.pow(10, -d)) {
    return v.toExponential(Math.min(d, 6));
  }
  return v.toFixed(d);
}

/** Join one row's already-formatted cells, quoting as needed. */
function row(cells: (string | number)[]): string {
  return cells.map((c) => csvCell(typeof c === "number" ? String(c) : c)).join(",");
}

/** Read a metric off a cycle by its typed key. `m.key` is `keyof CycleStats`,
 *  so this stays type-safe (value is `number | undefined` for optional keys). */
function metricValue(cyc: CycleStats, m: { key: keyof CycleStats }): number | undefined {
  return cyc[m.key];
}

/** The metric columns to include for a set of cycles: drop knock_integral
 *  entirely unless at least one cycle carries it (optional field, old studies
 *  lack it — an all-empty column is just noise). */
function metricColumnsFor(cycles: CycleStats[]) {
  const anyKnock = cycles.some((c) => c.knockIntegral != null);
  return CYCLE_METRICS.filter((m) => m.key !== "knockIntegral" || anyKnock);
}

/** One row per cycle, every CYCLE_METRICS column. */
export function buildSingleRpmCsv(study: SingleRpmStudy): string {
  const cols = metricColumnsFor(study.cycles);
  const lines: string[] = [];
  lines.push(row(cols.map((m) => m.csvName)));
  lines.push(row(cols.map((m) => m.unit)));
  for (const cyc of study.cycles) {
    lines.push(row(cols.map((m) => num(metricValue(cyc, m), m.decimals))));
  }
  return lines.join("\n");
}

/** One row per completed RPM point: run metadata then the point's lastCycle
 *  metric columns (knock_integral only when any point carries it). */
export function buildSweepCsv(study: SweepStudy): string {
  const points = [...study.points].sort((a, b) => a.rpm - b.rpm);
  const cols = metricColumnsFor(points.map((p) => p.lastCycle));
  const meta = [
    "rpm",
    "converged_cycle",
    "n_cycles_run",
    "wall_time_s",
    "step_count",
    "nonconservation_max",
  ];
  const metaUnits = ["rpm", "-", "-", "s", "-", "kg"];
  const lines: string[] = [];
  lines.push(row([...meta, ...cols.map((m) => m.csvName)]));
  lines.push(row([...metaUnits, ...cols.map((m) => m.unit)]));
  for (const p of points) {
    const base = [
      num(p.rpm, 0),
      num(p.convergedCycle, 0),
      num(p.nCyclesRun, 0),
      num(p.wallTimeS, 3),
      num(p.stepCount, 0),
      num(p.nonconservationMax, 6),
    ];
    const metrics = cols.map((m) => num(metricValue(p.lastCycle, m), m.decimals));
    lines.push(row([...base, ...metrics]));
  }
  return lines.join("\n");
}

/** Long format: rpm, cycle, then metric columns — one row per captured cycle
 *  across every RPM point. Null when no point captured per-cycle data. */
export function buildSweepCyclesCsv(study: SweepStudy): string | null {
  const points = [...study.points].sort((a, b) => a.rpm - b.rpm);
  const allCycles = points.flatMap((p) => p.cycles ?? []);
  if (allCycles.length === 0) return null;
  const cols = metricColumnsFor(allCycles);
  const lines: string[] = [];
  lines.push(row(["rpm", "cycle", ...cols.map((m) => m.csvName)]));
  lines.push(row(["rpm", "-", ...cols.map((m) => m.unit)]));
  for (const p of points) {
    for (const cyc of p.cycles ?? []) {
      const base = [num(p.rpm, 0), num(cyc.cycle, 0)];
      const metrics = cols.map((m) => num(metricValue(cyc, m), m.decimals));
      lines.push(row([...base, ...metrics]));
    }
  }
  return lines.join("\n");
}

/** One row per trial: status, live rank/objective/delta, wall time, then one
 *  column per tunable parameter path. Pending/error rows are included with
 *  empty rank/objective — when the study is still running this is a partial
 *  snapshot with no waiting/warning rows. */
export function buildOptimizationTrialsCsv(
  study: OptimizationStudy,
  schema?: ParameterMeta[] | null,
): string {
  const paths = study.parameterPaths;
  const ranked = rankTrials(study.trials, study.objectiveDirection);
  const rankByIdx = new Map<number, { rank: number; deltaToBest: number; pctOfBest: number | null }>();
  for (const r of ranked) {
    rankByIdx.set(r.trial.trialIdx, {
      rank: r.rank,
      deltaToBest: r.deltaToBest,
      pctOfBest: r.pctOfBest,
    });
  }
  const objUnit = objectiveUnit(study.params.objective);
  // Parameter unit per path comes from the schema when we have it (best-effort).
  const unitOf = (path: string): string =>
    schema?.find((p) => p.path === path)?.unit ?? "";

  const meta = [
    "trial",
    "status",
    "rank",
    "objective",
    "delta_to_best",
    "pct_of_best",
    "wall_time_s",
  ];
  const metaUnits = ["-", "-", "-", objUnit, objUnit, "%", "s"];
  const lines: string[] = [];
  lines.push(row([...meta, ...paths]));
  lines.push(row([...metaUnits, ...paths.map(unitOf)]));

  // Stable order: trialIdx ascending (matches event arrival / table default).
  const trials = [...study.trials].sort((a, b) => a.trialIdx - b.trialIdx);
  for (const t of trials) {
    const r = rankByIdx.get(t.trialIdx);
    const cells: string[] = [
      num(t.trialIdx, 0),
      t.status,
      r ? String(r.rank) : "",
      num(t.objectiveValue ?? undefined, 6),
      r ? num(r.deltaToBest, 6) : "",
      r && r.pctOfBest != null ? num(r.pctOfBest, 3) : "",
      num(t.wallTimeS ?? undefined, 3),
    ];
    for (const path of paths) {
      cells.push(num(t.parameterValues[path], 6));
    }
    lines.push(row(cells));
  }
  return lines.join("\n");
}

/** Long format: trial, rank, rpm, then lastCycle metric columns — one block
 *  per done trial that recorded sweepPoints. Null when no such trial exists. */
export function buildOptimizationCurvesCsv(study: OptimizationStudy): string | null {
  const ranked = rankTrials(study.trials, study.objectiveDirection);
  const rankByIdx = new Map<number, number>();
  for (const r of ranked) rankByIdx.set(r.trial.trialIdx, r.rank);

  const rows = [...study.trials]
    .filter((t) => t.status === "done" && t.sweepPoints && t.sweepPoints.length > 0)
    .sort((a, b) => a.trialIdx - b.trialIdx);
  if (rows.length === 0) return null;

  const allCycles = rows.flatMap((t) => (t.sweepPoints ?? []).map((p) => p.lastCycle));
  const cols = metricColumnsFor(allCycles);
  const lines: string[] = [];
  lines.push(row(["trial", "rank", "rpm", ...cols.map((m) => m.csvName)]));
  lines.push(row(["-", "-", "rpm", ...cols.map((m) => m.unit)]));
  for (const t of rows) {
    const rank = rankByIdx.get(t.trialIdx);
    const pts = [...(t.sweepPoints ?? [])].sort((a, b) => a.rpm - b.rpm);
    for (const p of pts) {
      const base = [num(t.trialIdx, 0), rank != null ? String(rank) : "", num(p.rpm, 0)];
      const metrics = cols.map((m) => num(metricValue(p.lastCycle, m), m.decimals));
      lines.push(row([...base, ...metrics]));
    }
  }
  return lines.join("\n");
}

/** Tab-separated trials, ONE header row, for clipboard paste into a sheet.
 *  Mirrors the trials-CSV columns minus the units row. */
export function buildTrialsTsv(study: OptimizationStudy): string {
  const paths = study.parameterPaths;
  const ranked = rankTrials(study.trials, study.objectiveDirection);
  const rankByIdx = new Map<number, { rank: number; deltaToBest: number }>();
  for (const r of ranked) {
    rankByIdx.set(r.trial.trialIdx, { rank: r.rank, deltaToBest: r.deltaToBest });
  }
  const header = [
    "trial",
    "status",
    "rank",
    "objective",
    "delta_to_best",
    "wall_time_s",
    ...paths,
  ];
  const lines: string[] = [header.join("\t")];
  const trials = [...study.trials].sort((a, b) => a.trialIdx - b.trialIdx);
  for (const t of trials) {
    const r = rankByIdx.get(t.trialIdx);
    const cells: string[] = [
      String(t.trialIdx),
      t.status,
      r ? String(r.rank) : "",
      num(t.objectiveValue ?? undefined, 6),
      r ? num(r.deltaToBest, 6) : "",
      num(t.wallTimeS ?? undefined, 3),
    ];
    for (const path of paths) cells.push(num(t.parameterValues[path], 6));
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}
