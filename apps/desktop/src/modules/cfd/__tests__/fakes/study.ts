// Factories for Study, CycleStats, LoadedConfig test fixtures.

import type {
  ConfigSummary,
  CycleStats,
  LoadedConfig,
  ObjectiveSpec,
  OptimizationParams,
  OptimizationStudy,
  OptimizationTrial,
  SingleRpmParams,
  SingleRpmStudy,
  SweepParams,
  SweepPoint,
  SweepStudy,
} from "../../state/types";

export function makeCycleStats(overrides: Partial<CycleStats> = {}): CycleStats {
  // knockIntegral is intentionally NOT defaulted: old persisted studies lack
  // it, so the field is opt-in via overrides (e.g. makeCycleStats({ knockIntegral: 0.4 })).
  return {
    cycle: 1,
    massTotal: 1e-3,
    massDrift: 0,
    massInRestrictor: 0,
    massOutCollector: 0,
    netPortFlow: 0,
    nonconservation: 0,
    imepBar: 10.0,
    bmepBar: 9.0,
    fmepBar: 1.0,
    veAtm: 0.75,
    intakeMassPerCycleG: 0.5,
    fResidual: 0.05,
    indicatedPowerKW: 20.0,
    indicatedPowerHp: 26.8,
    brakePowerKW: 18.0,
    brakePowerHp: 24.1,
    wheelPowerKW: 15.3,
    wheelPowerHp: 20.5,
    indicatedTorqueNm: 31.8,
    brakeTorqueNm: 28.6,
    wheelTorqueNm: 24.3,
    egtMean: 950.0,
    ...overrides,
  };
}

export function makeParams(overrides: Partial<SingleRpmParams> = {}): SingleRpmParams {
  return {
    rpm: 6000,
    nCyclesMax: 25,
    junctionKind: "stagnation",
    convergenceTolImep: 1e-3,
    convergenceMinCycles: 5,
    captureWaves: false,
    capturePvLoops: false,
    capturePipeProfiles: false,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<ConfigSummary> = {}): ConfigSummary {
  return {
    displayName: "Honda CBR600RR (FSAE)",
    nCylinders: 4,
    boreMm: 67.0,
    strokeMm: 42.5,
    compressionRatio: 12.2,
    displacementL: 0.599,
    restrictorThroatMm: 20.0,
    plenumVolumeL: 1.5,
    ...overrides,
  };
}

export function makeLoadedConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    path: "C:/configs/sdm26.json",
    raw: { name: "Honda CBR600RR (FSAE)", n_cylinders: 4 },
    summary: makeSummary(),
    isExample: false,
    ...overrides,
  };
}

export function makeStudy(overrides: Partial<SingleRpmStudy> = {}): SingleRpmStudy {
  return {
    id: "study-1",
    kind: "single-rpm",
    status: "idle",
    configPath: "C:/configs/sdm26.json",
    startedAt: 1_700_000_000_000,
    params: makeParams(),
    cycles: [],
    ...overrides,
  };
}

// ---- Sweep fixtures ----

export function makeSweepParams(overrides: Partial<SweepParams> = {}): SweepParams {
  return {
    rpmList: [8000, 10000, 12000],
    nCyclesMax: 25,
    junctionKind: "stagnation",
    convergenceTolImep: 1e-3,
    convergenceMinCycles: 5,
    captureWaves: false,
    capturePvLoops: false,
    capturePipeProfiles: false,
    ...overrides,
  };
}

/** One completed sweep point. `lastCycle` accepts a PARTIAL CycleStats so
 *  callers can shape peak curves with just the metrics they care about; the
 *  rest fall back to the makeCycleStats base. */
export function makeSweepPoint(
  overrides: Partial<Omit<SweepPoint, "lastCycle">> & { lastCycle?: Partial<CycleStats> } = {},
): SweepPoint {
  const { lastCycle, ...rest } = overrides;
  return {
    rpm: 10000,
    convergedCycle: 12,
    nCyclesRun: 15,
    lastCycle: makeCycleStats(lastCycle),
    nonconservationMax: 1e-6,
    wallTimeS: 4.2,
    stepCount: 100_000,
    cycles: [],
    ...rest,
  };
}

export function makeSweepStudy(overrides: Partial<SweepStudy> = {}): SweepStudy {
  return {
    id: "sweep-1",
    kind: "sweep",
    status: "done",
    configPath: "C:/configs/sdm26.json",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
    params: makeSweepParams(),
    points: [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50, brakeTorqueNm: 59.7, veAtm: 0.90 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64, brakeTorqueNm: 61.1, veAtm: 0.96 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 58, brakeTorqueNm: 46.2, veAtm: 0.88 } }),
    ],
    ...overrides,
  };
}

// ---- Optimization fixtures ----

export function makeObjective(overrides: Partial<ObjectiveSpec> = {}): ObjectiveSpec {
  return {
    metric: "brake_power_k_w",
    aggregator: { kind: "max" },
    rpmList: [8000, 10000, 12000],
    direction: "maximize",
    ...overrides,
  };
}

export function makeOptimizationParams(
  overrides: Partial<OptimizationParams> = {},
): OptimizationParams {
  return {
    tunables: [
      { path: "runner_length", min: 0.2, max: 0.4, step: null },
      { path: "plenum_volume_l", min: 1.0, max: 2.5, step: null },
    ],
    objective: makeObjective(),
    nTrials: 20,
    sampler: "lhs",
    seed: 42,
    nCyclesMax: 25,
    junctionKind: "stagnation",
    convergenceTolImep: 1e-3,
    convergenceMinCycles: 5,
    lockedPairs: [],
    ...overrides,
  };
}

/** A single optimization trial. Defaults to a completed, finite trial; pass
 *  `status`/`objectiveValue` overrides for pending/running/error/non-finite
 *  cases. `parameterValues` defaults cover the makeOptimizationParams paths. */
export function makeTrial(overrides: Partial<OptimizationTrial> = {}): OptimizationTrial {
  return {
    trialIdx: 0,
    parameterValues: { runner_length: 0.3, plenum_volume_l: 1.5 },
    status: "done",
    objectiveValue: 60,
    sweepPoints: null,
    wallTimeS: 4.0,
    ...overrides,
  };
}

export function makeOptimizationStudy(
  overrides: Partial<OptimizationStudy> = {},
): OptimizationStudy {
  const params = overrides.params ?? makeOptimizationParams();
  return {
    id: "opt-1",
    kind: "optimization",
    status: "done",
    configPath: "C:/configs/sdm26.json",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_200_000,
    params,
    trials: [
      makeTrial({ trialIdx: 0, objectiveValue: 55, parameterValues: { runner_length: 0.25, plenum_volume_l: 1.2 } }),
      makeTrial({ trialIdx: 1, objectiveValue: 64, parameterValues: { runner_length: 0.32, plenum_volume_l: 1.8 } }),
      makeTrial({ trialIdx: 2, objectiveValue: 60, parameterValues: { runner_length: 0.30, plenum_volume_l: 1.5 } }),
    ],
    bestTrialIdx: 1,
    bestObjectiveValue: 64,
    parameterPaths: ["runner_length", "plenum_volume_l"],
    objectiveDirection: params.objective.direction,
    ...overrides,
  };
}
