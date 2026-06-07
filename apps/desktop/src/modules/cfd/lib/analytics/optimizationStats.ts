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
