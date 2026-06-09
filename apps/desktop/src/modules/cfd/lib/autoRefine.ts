// Auto-refine controller (roadmap #8): run several "Refine around #1" rounds
// automatically, stopping when the best stops improving. Each round starts a
// NEW optimization study (the backend sampler is space-filling, so convergence
// needs re-sampling in a narrowed box) — which remounts the results screen, so
// the loop's state lives here at module level, keyed by the study id the loop
// is currently waiting on. The screen reads/advances it from an effect.
//
// Scope: the loop lives in this session — closing the app stops the LOOP (any
// running job continues server-side). Stop also only stops the loop; it never
// cancels a running job.

export interface AutoRefineState {
  /** The study id the loop is waiting on (the round currently running). */
  studyId: string;
  /** Rounds remaining AFTER the current one. */
  roundsLeft: number;
  /** Round number currently running (1-based) and the total requested. */
  round: number;
  totalRounds: number;
  /** Best objective value (in the loop's ranking dimension) BEFORE this round. */
  lastBest: number | null;
}

let current: AutoRefineState | null = null;

export function getAutoRefine(): AutoRefineState | null {
  return current;
}

export function setAutoRefine(state: AutoRefineState | null): void {
  current = state;
}

/** Minimum relative improvement for a round to count as progress. */
export const MIN_REL_IMPROVEMENT = 0.005;

/** Did this round improve enough to justify another? Direction-aware; a first
 *  round (no prior best) always continues. */
export function improvedEnough(
  lastBest: number | null,
  newBest: number,
  direction: "maximize" | "minimize",
  minRel = MIN_REL_IMPROVEMENT,
): boolean {
  if (lastBest == null || !Number.isFinite(lastBest)) return true;
  const gain = (newBest - lastBest) * (direction === "maximize" ? 1 : -1);
  const scale = Math.max(Math.abs(lastBest), 1e-12);
  return gain / scale >= minRel;
}
