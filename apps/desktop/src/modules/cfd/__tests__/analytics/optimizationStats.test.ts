import { describe, expect, it } from "vitest";
import {
  etaSeconds,
  rankTrials,
  runningBest,
  spearman,
  sensitivityTornado,
} from "../../lib/analytics/optimizationStats";
import { makeTrial } from "../fakes/study";

describe("rankTrials", () => {
  it("ranks maximize best-first with sequential ranks", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 55 }),
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
      makeTrial({ trialIdx: 2, objectiveValue: 60 }),
    ];
    const ranked = rankTrials(trials, "maximize");
    expect(ranked.map((r) => r.trial.trialIdx)).toEqual([1, 2, 0]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("ranks minimize best-first (lowest objective wins)", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 55 }),
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
      makeTrial({ trialIdx: 2, objectiveValue: 60 }),
    ];
    const ranked = rankTrials(trials, "minimize");
    expect(ranked.map((r) => r.trial.trialIdx)).toEqual([0, 2, 1]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("computes signed deltaToBest (0 for rank 1) and pctOfBest", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 50 }),
      makeTrial({ trialIdx: 1, objectiveValue: 100 }),
    ];
    const ranked = rankTrials(trials, "maximize");
    expect(ranked[0]!.deltaToBest).toBe(0);
    expect(ranked[0]!.pctOfBest).toBe(0);
    expect(ranked[1]!.deltaToBest).toBe(-50);
    expect(ranked[1]!.pctOfBest).toBe(-50);
  });

  it("breaks objective ties by ascending trialIdx (first-best wins)", () => {
    const trials = [
      makeTrial({ trialIdx: 3, objectiveValue: 64 }),
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
      makeTrial({ trialIdx: 2, objectiveValue: 64 }),
    ];
    const ranked = rankTrials(trials, "maximize");
    // Equal objectives → ordered by trialIdx, distinct sequential ranks.
    expect(ranked.map((r) => r.trial.trialIdx)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("agrees with backend-style first-best: rank 1 === lowest trialIdx on a tie", () => {
    const trials = [
      makeTrial({ trialIdx: 5, objectiveValue: 64 }),
      makeTrial({ trialIdx: 2, objectiveValue: 64 }),
    ];
    const best = rankTrials(trials, "maximize")[0]!;
    expect(best.trial.trialIdx).toBe(2);
  });

  it("excludes pending / running / error / non-finite trials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, status: "pending", objectiveValue: null }),
      makeTrial({ trialIdx: 1, status: "running", objectiveValue: null }),
      makeTrial({ trialIdx: 2, status: "error", objectiveValue: null }),
      makeTrial({ trialIdx: 3, status: "done", objectiveValue: NaN }),
      makeTrial({ trialIdx: 4, status: "done", objectiveValue: Infinity }),
      makeTrial({ trialIdx: 5, status: "done", objectiveValue: 42 }),
    ];
    const ranked = rankTrials(trials, "maximize");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.trial.trialIdx).toBe(5);
  });

  it("returns pctOfBest null when best === 0", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 0 }),
      makeTrial({ trialIdx: 1, objectiveValue: -5 }),
    ];
    const ranked = rankTrials(trials, "maximize");
    expect(ranked[0]!.deltaToBest).toBe(0);
    expect(ranked[0]!.pctOfBest).toBeNull();
    expect(ranked[1]!.deltaToBest).toBe(-5);
    expect(ranked[1]!.pctOfBest).toBeNull();
  });

  it("returns [] when no rankable trials", () => {
    const trials = [makeTrial({ trialIdx: 0, status: "pending", objectiveValue: null })];
    expect(rankTrials(trials, "maximize")).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 55 }),
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
    ];
    rankTrials(trials, "maximize");
    expect(trials.map((t) => t.trialIdx)).toEqual([0, 1]);
  });
});

describe("runningBest", () => {
  it("tracks the monotone best-so-far over ascending trialIdx (maximize)", () => {
    const trials = [
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
      makeTrial({ trialIdx: 0, objectiveValue: 50 }),
      makeTrial({ trialIdx: 2, objectiveValue: 60 }),
    ];
    const hist = runningBest(trials, "maximize");
    expect(hist.map((h) => h.trialIdx)).toEqual([0, 1, 2]);
    expect(hist.map((h) => h.objective)).toEqual([50, 64, 60]);
    expect(hist.map((h) => h.bestSoFar)).toEqual([50, 64, 64]);
  });

  it("tracks the monotone best-so-far (minimize)", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 50 }),
      makeTrial({ trialIdx: 1, objectiveValue: 64 }),
      makeTrial({ trialIdx: 2, objectiveValue: 40 }),
    ];
    const hist = runningBest(trials, "minimize");
    expect(hist.map((h) => h.bestSoFar)).toEqual([50, 50, 40]);
  });

  it("skips non-finite / unfinished trials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 50 }),
      makeTrial({ trialIdx: 1, status: "running", objectiveValue: null }),
      makeTrial({ trialIdx: 2, objectiveValue: NaN }),
      makeTrial({ trialIdx: 3, objectiveValue: 60 }),
    ];
    const hist = runningBest(trials, "maximize");
    expect(hist.map((h) => h.trialIdx)).toEqual([0, 3]);
  });
});

describe("spearman", () => {
  it("returns +1 for a strictly increasing monotone (non-linear) relation", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => x ** 3); // monotone but not linear
    expect(spearman(xs, ys)).toBeCloseTo(1, 12);
  });

  it("returns -1 for a strictly decreasing monotone relation", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [50, 40, 30, 20, 10];
    expect(spearman(xs, ys)).toBeCloseTo(-1, 12);
  });

  it("matches the textbook ρ on a tie-free sample", () => {
    // ρ = 1 − 6Σd²/(n(n²−1)). x-ranks 1..5, y-ranks [3,1,4,5,2] → d=[-2,1,-1,-1,3],
    // Σd²=16, n=5 → 1 − 96/120 = 0.2.
    const xs = [10, 20, 30, 40, 50];
    const ys = [30, 10, 40, 50, 20];
    expect(spearman(xs, ys)).toBeCloseTo(0.2, 12);
  });

  it("handles ties via average ranks", () => {
    // ys all-equal → no rank variance → undefined → null.
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
    // A tie on xs still yields a defined correlation.
    const r = spearman([1, 1, 2, 3], [10, 20, 30, 40]);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
  });

  it("returns null below 3 pairs or on length mismatch", () => {
    expect(spearman([1, 2], [3, 4])).toBeNull();
    expect(spearman([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe("sensitivityTornado", () => {
  it("orders parameters by |ρ| descending and signs them", () => {
    // runner_length perfectly tracks objective up; plenum tracks it down weaker.
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 10, parameterValues: { runner_length: 0.20, plenum_volume_l: 2.4 } }),
      makeTrial({ trialIdx: 1, objectiveValue: 20, parameterValues: { runner_length: 0.25, plenum_volume_l: 1.9 } }),
      makeTrial({ trialIdx: 2, objectiveValue: 30, parameterValues: { runner_length: 0.30, plenum_volume_l: 2.1 } }),
      makeTrial({ trialIdx: 3, objectiveValue: 40, parameterValues: { runner_length: 0.35, plenum_volume_l: 1.5 } }),
    ];
    const t = sensitivityTornado(trials, ["runner_length", "plenum_volume_l"]);
    expect(t.map((e) => e.path)).toEqual(["runner_length", "plenum_volume_l"]);
    expect(t[0]!.rho).toBeCloseTo(1, 12); // monotone up
    expect(t[1]!.rho).toBeLessThan(0); // tracks down
    expect(Math.abs(t[0]!.rho)).toBeGreaterThanOrEqual(Math.abs(t[1]!.rho));
    expect(t[0]!.n).toBe(4);
  });

  it("omits pinned params (no variance) and non-finite/unfinished trials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 10, parameterValues: { runner_length: 0.3, plenum_volume_l: 2.0 } }),
      makeTrial({ trialIdx: 1, objectiveValue: 20, parameterValues: { runner_length: 0.3, plenum_volume_l: 1.5 } }),
      makeTrial({ trialIdx: 2, objectiveValue: 30, parameterValues: { runner_length: 0.3, plenum_volume_l: 1.0 } }),
      makeTrial({ trialIdx: 3, status: "running", objectiveValue: null, parameterValues: { runner_length: 0.9, plenum_volume_l: 9 } }),
    ];
    const t = sensitivityTornado(trials, ["runner_length", "plenum_volume_l"]);
    // runner_length is pinned at 0.3 → dropped; plenum varies → kept.
    expect(t.map((e) => e.path)).toEqual(["plenum_volume_l"]);
    expect(t[0]!.n).toBe(3);
  });

  it("returns [] when too few finite trials to correlate", () => {
    const trials = [
      makeTrial({ trialIdx: 0, objectiveValue: 10 }),
      makeTrial({ trialIdx: 1, objectiveValue: 20 }),
    ];
    expect(sensitivityTornado(trials, ["runner_length", "plenum_volume_l"])).toEqual([]);
  });
});

describe("etaSeconds", () => {
  it("returns null with fewer than 3 finite-wall done trials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, wallTimeS: 4 }),
      makeTrial({ trialIdx: 1, wallTimeS: 4 }),
    ];
    expect(etaSeconds(trials, 10)).toBeNull();
  });

  it("estimates mean wall × remaining trials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, wallTimeS: 2 }),
      makeTrial({ trialIdx: 1, wallTimeS: 4 }),
      makeTrial({ trialIdx: 2, wallTimeS: 6 }),
    ];
    // mean = 4, remaining = 10 - 3 = 7 → 28.
    expect(etaSeconds(trials, 10)).toBe(28);
  });

  it("clamps remaining at 0 when nDone ≥ nTrials", () => {
    const trials = [
      makeTrial({ trialIdx: 0, wallTimeS: 2 }),
      makeTrial({ trialIdx: 1, wallTimeS: 4 }),
      makeTrial({ trialIdx: 2, wallTimeS: 6 }),
    ];
    expect(etaSeconds(trials, 3)).toBe(0);
    expect(etaSeconds(trials, 2)).toBe(0);
  });

  it("ignores trials with null / non-finite wall time", () => {
    const trials = [
      makeTrial({ trialIdx: 0, wallTimeS: 4 }),
      makeTrial({ trialIdx: 1, wallTimeS: null }),
      makeTrial({ trialIdx: 2, status: "running", wallTimeS: null }),
    ];
    // Only one finite-wall done trial → below the 3-sample gate.
    expect(etaSeconds(trials, 10)).toBeNull();
  });
});
