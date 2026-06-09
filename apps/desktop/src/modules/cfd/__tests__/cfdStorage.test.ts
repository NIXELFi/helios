import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { savePersisted, loadPersisted } from "../lib/cfdStorage";
import { makeOptimizationStudy, makeTrial, makeSweepPoint } from "./fakes/study";

// Build an optimization study whose trials carry sweepPoints, so we can watch
// which curves survive a quota-driven degradation.
function bigOptStudy() {
  const trials = Array.from({ length: 4 }, (_, i) =>
    makeTrial({
      trialIdx: i,
      objectiveValue: 50 + i,
      sweepPoints: [makeSweepPoint({ rpm: 8000 }), makeSweepPoint({ rpm: 10000 })],
    }),
  );
  return makeOptimizationStudy({ trials, bestTrialIdx: 2, bestObjectiveValue: 52 });
}

describe("cfdStorage degradation under quota", () => {
  const realSetItem = Storage.prototype.setItem;
  afterEach(() => {
    Storage.prototype.setItem = realSetItem;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  beforeEach(() => window.localStorage.clear());

  it("keeps the best trial's sweepPoints when full fidelity won't fit", () => {
    // Reject any write whose payload still contains a NON-best trial's
    // sweepPoints (simulates the full + per-cycle levels overflowing quota),
    // accept once they're gone. Forces the "best-trial-only" degradation level.
    const map = new Map<string, string>();
    Storage.prototype.setItem = function (k: string, v: string) {
      // Non-best trials are idx 0,1,3; best is 2. Reject while idx 0/1/3 still
      // carry sweepPoints (heuristic: count of "sweepPoints":[ occurrences > 1).
      const withCurves = (v.match(/"sweepPoints":\[\{/g) ?? []).length;
      if (withCurves > 1) {
        const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
      }
      map.set(k, v);
    };

    savePersisted({ lastConfigPath: "x", studies: [bigOptStudy()], vehicleConfig: null, referenceBaseline: null });

    // Restore + read back what landed.
    Storage.prototype.setItem = realSetItem;
    for (const [k, v] of map) window.localStorage.setItem(k, v);
    const got = loadPersisted();
    const study = got.studies[0];
    expect(study?.kind).toBe("optimization");
    if (study?.kind === "optimization") {
      const best = study.trials.find((t) => t.trialIdx === 2);
      const other = study.trials.find((t) => t.trialIdx === 0);
      expect(best?.sweepPoints?.length).toBeGreaterThan(0); // best curve survived
      expect(other?.sweepPoints).toBeNull(); // others dropped
    }
  });

  it("round-trips a normal study at full fidelity", () => {
    savePersisted({ lastConfigPath: "y", studies: [bigOptStudy()], vehicleConfig: null, referenceBaseline: null });
    const got = loadPersisted();
    expect(got.studies).toHaveLength(1);
    const s = got.studies[0];
    if (s?.kind === "optimization") {
      // No quota pressure → every trial keeps its sweepPoints.
      expect(s.trials.every((t) => (t.sweepPoints?.length ?? 0) > 0)).toBe(true);
    }
  });
});
