// Factories for Study, CycleStats, LoadedConfig test fixtures.

import type {
  ConfigSummary,
  CycleStats,
  LoadedConfig,
  SingleRpmParams,
  SingleRpmStudy,
} from "../../state/types";

export function makeCycleStats(overrides: Partial<CycleStats> = {}): CycleStats {
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
