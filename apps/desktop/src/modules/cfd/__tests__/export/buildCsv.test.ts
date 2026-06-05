// Structural assertions for the pure CSV builders. We don't snapshot the whole
// file (column order is owned by metricMeta and shouldn't pin tests) — instead
// we assert the load-bearing contracts: two header rows, a units row, blank
// cells for non-finite values, knock-column presence/absence, the
// running-study partial snapshot, and the optimization rank column agreeing
// with rankTrials. Study literals are built inline to avoid coupling to the
// shared fakes file while A1 still owns it.

import { describe, expect, it } from "vitest";
import type {
  CycleStats,
  OptimizationStudy,
  OptimizationTrial,
  SingleRpmStudy,
  SweepPoint,
  SweepStudy,
} from "../../state/types";
import {
  buildOptimizationCurvesCsv,
  buildOptimizationTrialsCsv,
  buildSingleRpmCsv,
  buildSweepCsv,
  buildSweepCyclesCsv,
  buildTrialsTsv,
} from "../../lib/export/buildCsv";

// --- inline fixtures -------------------------------------------------------

function cyc(overrides: Partial<CycleStats> = {}): CycleStats {
  return {
    cycle: 1,
    massTotal: 1e-3,
    massDrift: 0,
    massInRestrictor: 0,
    massOutCollector: 0,
    netPortFlow: 0,
    nonconservation: 0,
    imepBar: 10,
    bmepBar: 9,
    fmepBar: 1,
    veAtm: 0.9,
    intakeMassPerCycleG: 0.5,
    fResidual: 0.05,
    indicatedPowerKW: 20,
    indicatedPowerHp: 26.8,
    brakePowerKW: 18,
    brakePowerHp: 24.1,
    wheelPowerKW: 15.3,
    wheelPowerHp: 20.5,
    indicatedTorqueNm: 31.8,
    brakeTorqueNm: 28.6,
    wheelTorqueNm: 24.3,
    egtMean: 950,
    ...overrides,
  };
}

function sweepPoint(rpm: number, overrides: Partial<SweepPoint> = {}): SweepPoint {
  return {
    rpm,
    convergedCycle: 12,
    nCyclesRun: 15,
    lastCycle: cyc({ cycle: 15 }),
    nonconservationMax: 1e-6,
    wallTimeS: 4.2,
    stepCount: 1000,
    cycles: [],
    ...overrides,
  };
}

function trial(overrides: Partial<OptimizationTrial> = {}): OptimizationTrial {
  return {
    trialIdx: 0,
    parameterValues: { "runner_length[0]": 0.3 },
    status: "done",
    objectiveValue: 18,
    sweepPoints: null,
    wallTimeS: 5,
    ...overrides,
  };
}

function optStudy(trials: OptimizationTrial[], overrides: Partial<OptimizationStudy> = {}): OptimizationStudy {
  return {
    id: "opt-1",
    kind: "optimization",
    status: "done",
    configPath: "C:/configs/sdm26.json",
    startedAt: 1,
    params: {
      tunables: [{ path: "runner_length[0]", min: 0.2, max: 0.4, step: null }],
      objective: { metric: "brake_power_k_w", aggregator: { kind: "max" }, rpmList: [8000], direction: "maximize" },
      nTrials: 3,
      sampler: "lhs",
      seed: 42,
      nCyclesMax: 25,
      junctionKind: "stagnation",
      convergenceTolImep: 1e-3,
      convergenceMinCycles: 5,
      lockedPairs: [],
    },
    trials,
    bestTrialIdx: 0,
    bestObjectiveValue: 18,
    parameterPaths: ["runner_length[0]"],
    objectiveDirection: "maximize",
    ...overrides,
  };
}

const lines = (csv: string) => csv.split("\n");

// --- single-rpm ------------------------------------------------------------

describe("buildSingleRpmCsv", () => {
  it("emits two header rows (names then units) and one row per cycle", () => {
    const study: SingleRpmStudy = {
      id: "s1",
      kind: "single-rpm",
      status: "done",
      configPath: "c.json",
      startedAt: 1,
      params: {} as never,
      cycles: [cyc({ cycle: 1 }), cyc({ cycle: 2 })],
    };
    const out = lines(buildSingleRpmCsv(study));
    expect(out.length).toBe(4); // 2 header + 2 data
    expect(out[0]!.split(",")).toContain("cycle");
    // units row must differ from the names row
    expect(out[1]).not.toBe(out[0]);
  });

  it("omits knock_integral when no cycle carries it, includes it when present", () => {
    const without: SingleRpmStudy = {
      id: "s", kind: "single-rpm", status: "done", configPath: "c", startedAt: 1,
      params: {} as never, cycles: [cyc()],
    };
    expect(buildSingleRpmCsv(without).split("\n")[0]).not.toContain("knock_integral");

    const withKnock: SingleRpmStudy = {
      id: "s", kind: "single-rpm", status: "done", configPath: "c", startedAt: 1,
      params: {} as never,
      cycles: [cyc({ knockIntegral: 0.4 } as Partial<CycleStats>)],
    };
    expect(buildSingleRpmCsv(withKnock).split("\n")[0]).toContain("knock_integral");
  });

  it("renders non-finite metric values as an empty cell", () => {
    const study: SingleRpmStudy = {
      id: "s", kind: "single-rpm", status: "done", configPath: "c", startedAt: 1,
      params: {} as never,
      cycles: [cyc({ imepBar: NaN })],
    };
    const header = buildSingleRpmCsv(study).split("\n")[0]!.split(",");
    const imepCol = header.indexOf("imep");
    expect(imepCol).toBeGreaterThanOrEqual(0);
    const dataCells = buildSingleRpmCsv(study).split("\n")[2]!.split(",");
    expect(dataCells[imepCol]).toBe("");
  });
});

// --- sweep -----------------------------------------------------------------

describe("buildSweepCsv", () => {
  it("has run-metadata columns then metric columns, one row per rpm sorted asc", () => {
    const study: SweepStudy = {
      id: "sw", kind: "sweep", status: "done", configPath: "c", startedAt: 1,
      params: {} as never,
      points: [sweepPoint(10000), sweepPoint(8000)],
    };
    const out = lines(buildSweepCsv(study));
    const header = out[0]!.split(",");
    expect(header.slice(0, 6)).toEqual([
      "rpm", "converged_cycle", "n_cycles_run", "wall_time_s", "step_count", "nonconservation_max",
    ]);
    expect(out.length).toBe(4); // 2 header + 2 points
    // sorted ascending: first data row is 8000
    expect(out[2]!.split(",")[0]).toBe("8000");
  });

  it("buildSweepCyclesCsv is null without captured cycles, long format when present", () => {
    const empty: SweepStudy = {
      id: "sw", kind: "sweep", status: "done", configPath: "c", startedAt: 1,
      params: {} as never, points: [sweepPoint(8000)],
    };
    expect(buildSweepCyclesCsv(empty)).toBeNull();

    const withCycles: SweepStudy = {
      id: "sw", kind: "sweep", status: "done", configPath: "c", startedAt: 1,
      params: {} as never,
      points: [sweepPoint(8000, { cycles: [cyc({ cycle: 1 }), cyc({ cycle: 2 })] })],
    };
    const csv = buildSweepCyclesCsv(withCycles)!;
    const header = csv.split("\n")[0]!.split(",");
    expect(header.slice(0, 2)).toEqual(["rpm", "cycle"]);
    expect(csv.split("\n").length).toBe(4); // 2 header + 2 cycles
  });
});

// --- optimization ----------------------------------------------------------

describe("buildOptimizationTrialsCsv", () => {
  it("rank column agrees with best-first ordering and includes a param column", () => {
    const study = optStudy([
      trial({ trialIdx: 0, objectiveValue: 12, parameterValues: { "runner_length[0]": 0.3 } }),
      trial({ trialIdx: 1, objectiveValue: 20, parameterValues: { "runner_length[0]": 0.35 } }),
      trial({ trialIdx: 2, objectiveValue: 15, parameterValues: { "runner_length[0]": 0.32 } }),
    ]);
    const csv = buildOptimizationTrialsCsv(study);
    const out = lines(csv);
    const header = out[0]!.split(",");
    expect(header.slice(0, 7)).toEqual([
      "trial", "status", "rank", "objective", "delta_to_best", "pct_of_best", "wall_time_s",
    ]);
    expect(header).toContain("runner_length[0]");
    const rankCol = header.indexOf("rank");
    const trialCol = header.indexOf("trial");
    // rows are trialIdx-ascending; trial 1 (objective 20, maximize) is rank 1.
    const rowByTrial = (idx: number) =>
      out.slice(2).map((l) => l.split(",")).find((c) => c[trialCol] === String(idx))!;
    expect(rowByTrial(1)[rankCol]).toBe("1");
    expect(rowByTrial(2)[rankCol]).toBe("2");
    expect(rowByTrial(0)[rankCol]).toBe("3");
  });

  it("includes pending/error rows with empty rank/objective (partial snapshot)", () => {
    const study = optStudy(
      [
        trial({ trialIdx: 0, status: "done", objectiveValue: 18 }),
        trial({ trialIdx: 1, status: "pending", objectiveValue: null, wallTimeS: null }),
      ],
      { status: "running" },
    );
    const out = lines(buildOptimizationTrialsCsv(study));
    const header = out[0]!.split(",");
    const rankCol = header.indexOf("rank");
    const objCol = header.indexOf("objective");
    const statusCol = header.indexOf("status");
    const pending = out.slice(2).map((l) => l.split(",")).find((c) => c[statusCol] === "pending")!;
    expect(pending[rankCol]).toBe("");
    expect(pending[objCol]).toBe("");
    // no waiting/warning rows: exactly 2 data rows
    expect(out.length).toBe(4);
  });

  it("buildOptimizationCurvesCsv is null without done-trial sweepPoints", () => {
    const study = optStudy([trial({ trialIdx: 0, sweepPoints: null })]);
    expect(buildOptimizationCurvesCsv(study)).toBeNull();
  });

  it("buildOptimizationCurvesCsv long format with trial/rank/rpm prefix", () => {
    const study = optStudy([
      trial({ trialIdx: 0, status: "done", objectiveValue: 18, sweepPoints: [
        { ...sweepPoint(8000), cycles: [] },
        { ...sweepPoint(10000), cycles: [] },
      ] }),
    ]);
    const csv = buildOptimizationCurvesCsv(study)!;
    const header = csv.split("\n")[0]!.split(",");
    expect(header.slice(0, 3)).toEqual(["trial", "rank", "rpm"]);
    expect(csv.split("\n").length).toBe(4); // 2 header + 2 rpm rows
  });
});

describe("buildTrialsTsv", () => {
  it("is tab-separated with a single header row", () => {
    const study = optStudy([trial({ trialIdx: 0 }), trial({ trialIdx: 1, objectiveValue: 20 })]);
    const out = lines(buildTrialsTsv(study));
    expect(out[0]).toContain("\t");
    expect(out[0]!.split("\t")).toContain("rank");
    expect(out.length).toBe(3); // 1 header + 2 trials (NO units row)
  });
});
