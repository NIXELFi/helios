// Display-side live selectors for the optimization screen. Everything here is
// derived purely from the study's reducer state — we never mutate the study and
// never re-derive `bestTrialIdx`. After the job finishes, `ranked[0]` agrees
// with the backend's first-best (same comparison direction; ties broken by
// ascending trialIdx). See lib/analytics/optimizationStats.ts.
//
// The whole derivation is ONE useMemo keyed on the three inputs that can change
// it — the trials array reference (the reducer returns a NEW array per event,
// per the hard rules; do NOT key on study.id), the objective direction, and the
// trial count. The running elapsed clock is a SEPARATE 1 s interval, gated to
// status === "running" and cleaned up on unmount / status change, so the heavy
// memo never re-runs just to tick a second forward.

import { useEffect, useMemo, useState } from "react";

import type { OptimizationStudy, OptimizationTrial } from "./types";
import {
  etaSeconds,
  rankTrials,
  runningBest,
  type RankedTrial,
} from "../lib/analytics/optimizationStats";

export interface OptimizationLive {
  /** done + finite-objective trials, trialIdx ascending. */
  done: OptimizationTrial[];
  /** every rankable trial, best-first (rank 1..n). */
  ranked: RankedTrial[];
  /** ranked[0..2] — the podium (may be shorter than 3 early on). */
  top3: RankedTrial[];
  /** trialIdx -> rank, for O(1) lookups in the table / plots. */
  rankByIdx: Map<number, number>;
  /** trials currently executing (status === "running"). */
  running: OptimizationTrial[];
  /** running-best convergence curve over done trials (trialIdx ascending). */
  history: { trialIdx: number; objective: number; bestSoFar: number }[];
  /** rough ETA seconds for remaining trials, or null (<3 done w/ wall time). */
  eta: number | null;
  /** count of done + finite trials (podium / ETA gating). */
  nDone: number;
}

/** Derive the live optimization view-model. Pure with respect to the study —
 *  safe to call mid-run; one code path serves running and finished studies. */
export function useOptimizationLive(study: OptimizationStudy): OptimizationLive {
  return useMemo(() => {
    const trials = study.trials;
    const direction = study.objectiveDirection;

    const ranked = rankTrials(trials, direction);
    const rankByIdx = new Map<number, number>();
    for (const r of ranked) rankByIdx.set(r.trial.trialIdx, r.rank);

    // `done` mirrors rankTrials' rankable set but in trialIdx order (table /
    // convergence ordering), derived from the same ranked list to stay in sync.
    const done = ranked
      .map((r) => r.trial)
      .slice()
      .sort((a, b) => a.trialIdx - b.trialIdx);

    const running = trials.filter((t) => t.status === "running");
    const history = runningBest(trials, direction);
    const eta = etaSeconds(trials, study.params.nTrials);

    return {
      done,
      ranked,
      top3: ranked.slice(0, 3),
      rankByIdx,
      running,
      history,
      eta,
      nDone: done.length,
    };
    // Key strictly on the reducer-owned references that can change the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.trials, study.objectiveDirection, study.params.nTrials]);
}

/** A 1 s elapsed clock that ticks ONLY while the study is running. Returns the
 *  elapsed seconds (finishedAt − startedAt once finished). Separate from the
 *  heavy memo so a wall-clock tick never re-derives rankings. */
export function useElapsedSeconds(study: OptimizationStudy): number {
  const isRunning = study.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const end = study.finishedAt ?? (isRunning ? now : Date.now());
  return Math.max(0, (end - study.startedAt) / 1000);
}
