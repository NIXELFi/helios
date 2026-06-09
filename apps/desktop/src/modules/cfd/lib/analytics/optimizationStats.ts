// Pure, display-side analytics for optimization studies.
//
// These selectors layer ON TOP of the reducer — they never mutate the study
// and never re-derive `bestTrialIdx`. After a job finishes, rank 1 here must
// agree with the backend's first-best (same comparison direction; ties broken
// by ascending trialIdx). No React / Tauri imports: this file is unit-testable
// in isolation and safe to import from anywhere.

import type { ObjectiveDirection, OptimizationTrial } from "../../state/types";

export interface RankedTrial {
  trial: OptimizationTrial;
  rank: number;
  /** trial.objectiveValue − best.objectiveValue (signed; 0 for rank 1). */
  deltaToBest: number;
  /** deltaToBest / |best| * 100; null when best === 0 (undefined percentage). */
  pctOfBest: number | null;
}

// A trial counts toward ranking only when it has actually produced a finite
// objective. Pending / running / errored trials and NaN/±Infinity values are
// excluded entirely (they get no rank).
function isRankable(t: OptimizationTrial): boolean {
  return (
    t.status === "done" &&
    t.objectiveValue !== null &&
    Number.isFinite(t.objectiveValue)
  );
}

/** Rank done+finite trials best-first by `direction`.
 *
 *  Ties on objective break to ascending trialIdx (matching the backend's
 *  keep-first-best behavior). Ranks are sequential 1..n with NO shared ranks —
 *  two equal objectives still get distinct ranks, ordered by trialIdx. */
export function rankTrials(
  trials: OptimizationTrial[],
  direction: ObjectiveDirection,
): RankedTrial[] {
  const rankable = trials.filter(isRankable);
  // Defensive copy before sort so we never reorder the caller's array.
  const sign = direction === "maximize" ? -1 : 1;
  const sorted = [...rankable].sort((a, b) => {
    const av = a.objectiveValue as number;
    const bv = b.objectiveValue as number;
    if (av !== bv) return sign * (av - bv);
    // Tie → ascending trialIdx (first-best wins).
    return a.trialIdx - b.trialIdx;
  });

  if (sorted.length === 0) return [];

  const best = sorted[0]!.objectiveValue as number;
  return sorted.map((trial, i) => {
    const value = trial.objectiveValue as number;
    const deltaToBest = value - best;
    const pctOfBest = best === 0 ? null : (deltaToBest / Math.abs(best)) * 100;
    return { trial, rank: i + 1, deltaToBest, pctOfBest };
  });
}

/** Running-best curve over done+finite trials in ascending trialIdx order.
 *
 *  Each entry carries that trial's own objective plus the best objective seen
 *  up to and including it (monotone by `direction`). Used to draw the
 *  convergence step line. */
export function runningBest(
  trials: OptimizationTrial[],
  direction: ObjectiveDirection,
): { trialIdx: number; objective: number; bestSoFar: number }[] {
  const done = trials
    .filter(isRankable)
    .sort((a, b) => a.trialIdx - b.trialIdx);

  const out: { trialIdx: number; objective: number; bestSoFar: number }[] = [];
  let bestSoFar: number | null = null;
  for (const t of done) {
    const value = t.objectiveValue as number;
    if (bestSoFar === null) {
      bestSoFar = value;
    } else if (direction === "maximize") {
      bestSoFar = Math.max(bestSoFar, value);
    } else {
      bestSoFar = Math.min(bestSoFar, value);
    }
    out.push({ trialIdx: t.trialIdx, objective: value, bestSoFar });
  }
  return out;
}

// ---- Sensitivity (Spearman rank correlation) ------------------------------

/** Fractional (average-tie) ranks of `values`, 1-based. Equal values share
 *  the mean of the ranks they span — the standard tie correction so Spearman
 *  stays well-defined on snapped/duplicate samples. */
function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1; // mean of 1-based positions i+1..j+1
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; null when n<3 or either side has zero variance. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // constant series → undefined
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation in [-1, 1] (Pearson of the average-tie ranks).
 *  null when fewer than 3 complete pairs or either side has no rank variance
 *  (all-equal). */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

export interface SensitivityEntry {
  path: string;
  /** Spearman ρ of this parameter vs the trial objective, in [-1, 1]. */
  rho: number;
  /** Number of finite paired samples the correlation was computed over. */
  n: number;
}

/** Spearman sensitivity of each tunable vs the trial objective, sorted by
 *  |ρ| descending — the tornado order (strongest driver on top).
 *
 *  Mines the done+finite trials already in the study; the objective is taken
 *  verbatim, so feeding a view-remapped study (objectiveValue = an FSAE event
 *  metric) yields the sensitivity in THAT dimension. A parameter is omitted
 *  when it has <3 finite paired samples or no variance over the trials (a
 *  pinned knob can't correlate with anything). Sign convention follows the raw
 *  objective: ρ>0 means a higher parameter tracks a higher objectiveValue —
 *  the caller knows whether higher is better from objectiveDirection. */
export function sensitivityTornado(
  trials: OptimizationTrial[],
  parameterPaths: string[],
): SensitivityEntry[] {
  const done = trials.filter(isRankable);
  const out: SensitivityEntry[] = [];
  for (const path of parameterPaths) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const t of done) {
      const x = t.parameterValues[path];
      const y = t.objectiveValue;
      if (x !== undefined && Number.isFinite(x) && y !== null && Number.isFinite(y)) {
        xs.push(x);
        ys.push(y);
      }
    }
    const rho = spearman(xs, ys);
    if (rho !== null) out.push({ path, rho, n: xs.length });
  }
  out.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  return out;
}

/** Rough ETA in seconds for the remaining trials.
 *
 *  null unless ≥3 done trials carry a finite wallTimeS (too few samples to
 *  trust). Estimate = mean(wallTimeS) × max(0, nTrials − nDone). */
export function etaSeconds(
  trials: OptimizationTrial[],
  nTrials: number,
): number | null {
  const wall = trials
    .filter((t) => t.status === "done" && t.wallTimeS !== null && Number.isFinite(t.wallTimeS))
    .map((t) => t.wallTimeS as number);
  if (wall.length < 3) return null;
  const mean = wall.reduce((s, v) => s + v, 0) / wall.length;
  const remaining = Math.max(0, nTrials - wall.length);
  return mean * remaining;
}
