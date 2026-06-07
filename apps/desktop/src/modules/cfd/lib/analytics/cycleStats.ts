// Pure analytics for single-RPM cycle series — convergence visualization and
// last-N coefficient-of-variation. DISPLAY ONLY: the authoritative convergence
// verdict is the backend's summary.convergedCycle, never re-derived here.
//
// No React / Tauri imports.

import type { CycleStats } from "../../state/types";

// Floor for the IMEP denominator so a near-zero previous cycle can't blow the
// percentage up to ±Infinity.
const EPS = 1e-9;

export interface CycleDelta {
  cycle: number;
  /** |IMEP_i − IMEP_{i−1}| / max(|IMEP_{i−1}|, ε), as a fraction (×100 for %). */
  deltaPct: number;
}

/** Per-cycle relative IMEP change vs the previous cycle.
 *
 *  The first cycle has no predecessor, so the series starts at the second
 *  cycle. Purely for the convergence chart — not a convergence test. */
export function imepDeltaSeries(cycles: CycleStats[]): CycleDelta[] {
  const out: CycleDelta[] = [];
  for (let i = 1; i < cycles.length; i++) {
    const prev = cycles[i - 1]!.imepBar;
    const cur = cycles[i]!.imepBar;
    const deltaPct = Math.abs(cur - prev) / Math.max(Math.abs(prev), EPS);
    out.push({ cycle: cycles[i]!.cycle, deltaPct });
  }
  return out;
}

/** Coefficient of variation (stdev / |mean|) of `field` over the last `n`
 *  cycles. Returns null with fewer than `n` cycles or when the mean is ≈0
 *  (CoV undefined). Uses the population stdev — small, fixed-window samples. */
export function covLastN(
  cycles: CycleStats[],
  field: keyof CycleStats & string,
  n = 5,
): number | null {
  if (cycles.length < n) return null;
  const window = cycles.slice(cycles.length - n);
  const values: number[] = [];
  for (const c of window) {
    const v = c[field];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    values.push(v);
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (Math.abs(mean) < EPS) return null;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Max knockIntegral across cycles; null when no cycle carries one. */
export function maxKnockIntegral(cycles: CycleStats[]): number | null {
  const knocks = cycles
    .map((c) => c.knockIntegral)
    .filter((v): v is number => v !== undefined && Number.isFinite(v));
  return knocks.length > 0 ? Math.max(...knocks) : null;
}
