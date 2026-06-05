// exportActionsFor dispatch tests. We vi.mock io.ts so no real save dialog /
// disk write runs — the spies let us assert WHICH builder output gets handed to
// saveTextFile, the filename stem shape (cfd-<kind>-<config>-<timestamp>), the
// per-kind action sets, conditional actions (sweep Cycles CSV / opt curves CSV
// only when data exists), and the best-effort schema fetch (catch → null).

import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  CycleStats,
  OptimizationStudy,
  ParameterMeta,
  SingleRpmStudy,
  SweepPoint,
  SweepStudy,
} from "../../state/types";

// --- mock the single IO seam ----------------------------------------------
const saveTextFile = vi.fn(async (_name: string, _ext: string, _contents: string) => "C:/out/file");
vi.mock("../../lib/export/io", () => ({
  saveTextFile: (...a: unknown[]) => saveTextFile(...(a as [string, string, string])),
  // fileTimestamp pinned so the stem is deterministic in assertions.
  fileTimestamp: () => "20260605-134501",
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
}));

import { exportActionsFor } from "../../lib/export/exportStudy";

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

function sweepPoint(rpm: number, overrides: Partial<SweepPoint> = {}): SweepPoint {
  return {
    rpm, convergedCycle: 12, nCyclesRun: 15, lastCycle: cyc({ cycle: 15 }),
    nonconservationMax: 1e-6, wallTimeS: 4.2, stepCount: 1000, cycles: [], ...overrides,
  };
}

const singleRpm: SingleRpmStudy = {
  id: "s1", kind: "single-rpm", status: "done", configPath: "C:/configs/My Config.json",
  startedAt: 1, params: {} as never, cycles: [cyc()],
};

function optStudy(overrides: Partial<OptimizationStudy> = {}): OptimizationStudy {
  return {
    id: "o1", kind: "optimization", status: "done", configPath: "C:/configs/sdm26.json",
    startedAt: 1,
    params: {
      tunables: [], objective: { metric: "brake_power_k_w", aggregator: { kind: "max" }, rpmList: [8000], direction: "maximize" },
      nTrials: 2, sampler: "lhs", seed: 42, nCyclesMax: 25, junctionKind: "stagnation",
      convergenceTolImep: 1e-3, convergenceMinCycles: 5, lockedPairs: [],
    },
    trials: [{ trialIdx: 0, parameterValues: {}, status: "done", objectiveValue: 18, sweepPoints: null, wallTimeS: 5 }],
    bestTrialIdx: 0, bestObjectiveValue: 18, parameterPaths: [], objectiveDirection: "maximize",
    ...overrides,
  };
}

beforeEach(() => saveTextFile.mockClear());

describe("exportActionsFor — single-rpm", () => {
  it("offers Cycles CSV + Study JSON", () => {
    const actions = exportActionsFor(singleRpm);
    expect(actions.map((a) => a.label)).toEqual(["Cycles CSV", "Study JSON"]);
  });

  it("uses a cfd-<kind>-<slug>-<timestamp> filename stem", async () => {
    const actions = exportActionsFor(singleRpm);
    await actions[0]!.run();
    const [name, ext] = saveTextFile.mock.calls[0]!;
    expect(name).toBe("cfd-single-rpm-my-config-20260605-134501-cycles");
    expect(ext).toBe("csv");
  });
});

describe("exportActionsFor — sweep", () => {
  it("omits Cycles CSV when no point captured cycles", () => {
    const study: SweepStudy = {
      id: "sw", kind: "sweep", status: "done", configPath: "c.json", startedAt: 1,
      params: {} as never, points: [sweepPoint(8000)],
    };
    expect(exportActionsFor(study).map((a) => a.label)).toEqual(["Per-RPM CSV", "Study JSON"]);
  });

  it("includes Cycles CSV when a point captured cycles", () => {
    const study: SweepStudy = {
      id: "sw", kind: "sweep", status: "done", configPath: "c.json", startedAt: 1,
      params: {} as never,
      points: [sweepPoint(8000, { cycles: [cyc()] })],
    };
    expect(exportActionsFor(study).map((a) => a.label)).toEqual([
      "Per-RPM CSV", "Cycles CSV", "Study JSON",
    ]);
  });
});

describe("exportActionsFor — optimization", () => {
  it("offers Trials CSV + Study JSON (no curves without sweepPoints)", () => {
    expect(exportActionsFor(optStudy()).map((a) => a.label)).toEqual(["Trials CSV", "Study JSON"]);
  });

  it("includes Trial curves CSV when a done trial has sweepPoints", () => {
    const study = optStudy({
      trials: [{ trialIdx: 0, parameterValues: {}, status: "done", objectiveValue: 18, sweepPoints: [sweepPoint(8000)], wallTimeS: 5 }],
    });
    expect(exportActionsFor(study).map((a) => a.label)).toEqual([
      "Trials CSV", "Trial curves CSV", "Study JSON",
    ]);
  });

  it("fetches schema best-effort and survives a rejecting getSchema (catch → null)", async () => {
    const getSchema = vi.fn(async (): Promise<ParameterMeta[]> => {
      throw new Error("schema unavailable");
    });
    const actions = exportActionsFor(optStudy(), { getSchema });
    const path = await actions[0]!.run(); // Trials CSV
    expect(getSchema).toHaveBeenCalledWith("C:/configs/sdm26.json");
    expect(path).toBe("C:/out/file"); // export still succeeded
    expect(saveTextFile).toHaveBeenCalledTimes(1);
  });

  it("passes a resolved schema through to the builder without throwing", async () => {
    const schema: ParameterMeta[] = [
      { path: "runner_length[0]", kind: "array", arrayLen: 4, unit: "m", default: 0.3, suggestedMin: 0.2, suggestedMax: 0.4, group: "runner" },
    ];
    const getSchema = vi.fn(async () => schema);
    const actions = exportActionsFor(optStudy(), { getSchema });
    await actions[0]!.run();
    expect(getSchema).toHaveBeenCalled();
    expect(saveTextFile).toHaveBeenCalledTimes(1);
  });
});
