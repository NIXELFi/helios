// Pure JSON builders. A study bundle is self-describing: enough meta + full
// params + raw results + a small derived block to reconstruct or re-run the
// study elsewhere. The bundle interfaces live HERE (not state/types.ts) — they
// are an export-format concern, not part of the live data model. No appVersion
// field (deliberately vetoed: hardcoding it lies the moment the build moves on;
// schemaVersion + exportedAt are the durable identity).

import type {
  CycleStats,
  OptimizationStudy,
  ParameterMeta,
  SingleRpmStudy,
  Study,
  StudyKind,
  StudyStatus,
  SweepStudy,
} from "../../state/types";
import { rankTrials } from "../analytics/optimizationStats";
import { summarizeSweep } from "../analytics/sweepStats";
import { covLastN, maxKnockIntegral } from "../analytics/cycleStats";

export interface StudyBundleMeta {
  schemaVersion: 1;
  exportedAt: string;
  kind: StudyKind;
  configPath: string;
  status: StudyStatus;
  startedAt: number;
  finishedAt?: number;
}

/** A single study, self-describing: meta + params + results + derived. */
interface StudyBundle {
  meta: StudyBundleMeta;
  params: unknown;
  results: unknown;
  derived: unknown;
  parameterSchema?: ParameterMeta[];
}

function metaFor(study: Study): StudyBundleMeta {
  const meta: StudyBundleMeta = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    kind: study.kind,
    configPath: study.configPath,
    status: study.status,
    startedAt: study.startedAt,
  };
  if (study.finishedAt != null) meta.finishedAt = study.finishedAt;
  return meta;
}

function singleRpmDerived(study: SingleRpmStudy) {
  const cycles: CycleStats[] = study.cycles;
  return {
    nCycles: cycles.length,
    covImepLast5: covLastN(cycles, "imepBar", 5),
    maxKnockIntegral: maxKnockIntegral(cycles),
    convergedCycle: study.summary?.convergedCycle ?? null,
  };
}

function sweepDerived(study: SweepStudy) {
  return summarizeSweep(study.points);
}

function optimizationDerived(study: OptimizationStudy) {
  const ranked = rankTrials(study.trials, study.objectiveDirection);
  // Top 10 ranked trials, each reproducible from its parameter values.
  const top = ranked.slice(0, 10).map((r) => ({
    rank: r.rank,
    trialIdx: r.trial.trialIdx,
    objectiveValue: r.trial.objectiveValue,
    deltaToBest: r.deltaToBest,
    parameterValues: r.trial.parameterValues,
  }));
  return {
    direction: study.objectiveDirection,
    bestTrialIdx: study.bestTrialIdx,
    bestObjectiveValue: study.bestObjectiveValue,
    top,
  };
}

function bundleFor(study: Study, schema?: ParameterMeta[] | null): StudyBundle {
  let params: unknown;
  let results: unknown;
  let derived: unknown;
  if (study.kind === "single-rpm") {
    params = study.params;
    results = { cycles: study.cycles };
    derived = singleRpmDerived(study);
  } else if (study.kind === "sweep") {
    params = study.params;
    results = { points: study.points };
    derived = sweepDerived(study);
  } else {
    // Optimization: capture EVERYTHING needed to reproduce a run — the full
    // tunables, objective, sampler, seed, and lockedPairs all live in params.
    params = study.params;
    results = { trials: study.trials };
    derived = optimizationDerived(study);
  }
  const bundle: StudyBundle = {
    meta: metaFor(study),
    params,
    results,
    derived,
  };
  if (schema) bundle.parameterSchema = schema;
  return bundle;
}

/** Pretty-printed JSON for a single study (one self-describing bundle). */
export function buildStudyJson(
  study: Study,
  opts?: { schema?: ParameterMeta[] | null },
): string {
  return JSON.stringify(bundleFor(study, opts?.schema), null, 2);
}

/** A workspace dump: every study bundled together under one envelope. */
export function buildWorkspaceJson(studies: Study[]): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      studies: studies.map((s) => bundleFor(s)),
    },
    null,
    2,
  );
}
