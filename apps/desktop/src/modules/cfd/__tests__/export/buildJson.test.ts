// Structural assertions for the JSON bundle builders. Key contracts: the
// reproducibility fields (sampler/seed/tunables/objective/lockedPairs) survive
// for optimization studies, there is NO appVersion field anywhere, the meta
// carries schemaVersion/exportedAt, and a workspace dump wraps one bundle per
// study. Inline fixtures avoid coupling to the shared fakes file.

import { describe, expect, it } from "vitest";
import type {
  CycleStats,
  OptimizationStudy,
  SingleRpmStudy,
  Study,
  SweepStudy,
} from "../../state/types";
import { buildStudyJson, buildWorkspaceJson } from "../../lib/export/buildJson";

function cyc(overrides: Partial<CycleStats> = {}): CycleStats {
  return {
    cycle: 1, massTotal: 1e-3, massDrift: 0, massInRestrictor: 0, massOutCollector: 0,
    netPortFlow: 0, nonconservation: 0, imepBar: 10, bmepBar: 9, fmepBar: 1, veAtm: 0.9,
    intakeMassPerCycleG: 0.5, fResidual: 0.05, indicatedPowerKW: 20, indicatedPowerHp: 26.8,
    brakePowerKW: 18, brakePowerHp: 24.1, wheelPowerKW: 15.3, wheelPowerHp: 20.5,
    indicatedTorqueNm: 31.8, brakeTorqueNm: 28.6, wheelTorqueNm: 24.3, egtMean: 950,
    ...overrides,
  };
}

const singleRpm: SingleRpmStudy = {
  id: "s1", kind: "single-rpm", status: "done", configPath: "C:/configs/sdm26.json",
  startedAt: 100, finishedAt: 200,
  params: { rpm: 8000 } as never,
  cycles: [cyc({ cycle: 1 }), cyc({ cycle: 2, imepBar: 10.1 })],
  summary: { convergedCycle: 7, nCyclesRun: 10, stepCount: 5000 },
};

const optStudy: OptimizationStudy = {
  id: "o1", kind: "optimization", status: "done", configPath: "C:/configs/sdm26.json",
  startedAt: 1,
  params: {
    tunables: [{ path: "runner_length[0]", min: 0.2, max: 0.4, step: null }],
    objective: { metric: "brake_power_k_w", aggregator: { kind: "max" }, rpmList: [8000], direction: "maximize" },
    nTrials: 2, sampler: "lhs", seed: 42, nCyclesMax: 25, junctionKind: "stagnation",
    convergenceTolImep: 1e-3, convergenceMinCycles: 5,
    lockedPairs: [{ leader: "a", follower: "b" }],
  },
  trials: [
    { trialIdx: 0, parameterValues: { "runner_length[0]": 0.3 }, status: "done", objectiveValue: 18, sweepPoints: null, wallTimeS: 5 },
    { trialIdx: 1, parameterValues: { "runner_length[0]": 0.35 }, status: "done", objectiveValue: 20, sweepPoints: null, wallTimeS: 5 },
  ],
  bestTrialIdx: 1, bestObjectiveValue: 20,
  parameterPaths: ["runner_length[0]"], objectiveDirection: "maximize",
};

describe("buildStudyJson", () => {
  it("meta carries schemaVersion + exportedAt and NO appVersion anywhere", () => {
    const obj = JSON.parse(buildStudyJson(singleRpm));
    expect(obj.meta.schemaVersion).toBe(1);
    expect(typeof obj.meta.exportedAt).toBe("string");
    expect(obj.meta.kind).toBe("single-rpm");
    expect(obj.meta.finishedAt).toBe(200);
    expect(buildStudyJson(singleRpm)).not.toContain("appVersion");
  });

  it("single-rpm derived block carries cov + maxKnockIntegral + convergedCycle", () => {
    const obj = JSON.parse(buildStudyJson(singleRpm));
    expect(obj.results.cycles.length).toBe(2);
    expect(obj.derived).toHaveProperty("covImepLast5");
    expect(obj.derived).toHaveProperty("maxKnockIntegral");
    expect(obj.derived.convergedCycle).toBe(7);
  });

  it("optimization params keep full reproducibility fields", () => {
    const obj = JSON.parse(buildStudyJson(optStudy));
    expect(obj.params.sampler).toBe("lhs");
    expect(obj.params.seed).toBe(42);
    expect(obj.params.tunables.length).toBe(1);
    expect(obj.params.objective.metric).toBe("brake_power_k_w");
    expect(obj.params.lockedPairs.length).toBe(1);
  });

  it("optimization derived block ranks trials best-first (top list)", () => {
    const obj = JSON.parse(buildStudyJson(optStudy));
    expect(Array.isArray(obj.derived.top)).toBe(true);
    expect(obj.derived.top[0].rank).toBe(1);
    expect(obj.derived.top[0].trialIdx).toBe(1); // objective 20 wins maximize
    expect(obj.derived.top.length).toBeLessThanOrEqual(10);
  });

  it("includes parameterSchema only when provided", () => {
    const withoutSchema = JSON.parse(buildStudyJson(optStudy));
    expect(withoutSchema.parameterSchema).toBeUndefined();
    const withSchema = JSON.parse(
      buildStudyJson(optStudy, {
        schema: [
          { path: "runner_length[0]", kind: "array", arrayLen: 4, unit: "m", default: 0.3, suggestedMin: 0.2, suggestedMax: 0.4, group: "runner" },
        ],
      }),
    );
    expect(withSchema.parameterSchema.length).toBe(1);
  });
});

describe("buildWorkspaceJson", () => {
  it("wraps one bundle per study under a versioned envelope", () => {
    const sweep: SweepStudy = {
      id: "w1", kind: "sweep", status: "done", configPath: "c", startedAt: 1,
      params: {} as never,
      points: [],
    };
    const studies: Study[] = [singleRpm, optStudy, sweep];
    const obj = JSON.parse(buildWorkspaceJson(studies));
    expect(obj.schemaVersion).toBe(1);
    expect(typeof obj.exportedAt).toBe("string");
    expect(obj.studies.length).toBe(3);
    expect(obj.studies.map((s: { meta: { kind: string } }) => s.meta.kind)).toEqual([
      "single-rpm", "optimization", "sweep",
    ]);
    expect(buildWorkspaceJson(studies)).not.toContain("appVersion");
  });
});
