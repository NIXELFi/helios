import { describe, expect, it } from "vitest";
import {
  covLastN,
  imepDeltaSeries,
  maxKnockIntegral,
} from "../../lib/analytics/cycleStats";
import { makeCycleStats } from "../fakes/study";

describe("imepDeltaSeries", () => {
  it("returns an empty series with fewer than 2 cycles", () => {
    expect(imepDeltaSeries([])).toEqual([]);
    expect(imepDeltaSeries([makeCycleStats({ cycle: 1, imepBar: 10 })])).toEqual([]);
  });

  it("computes the relative IMEP change per cycle starting from the second", () => {
    const cycles = [
      makeCycleStats({ cycle: 1, imepBar: 10 }),
      makeCycleStats({ cycle: 2, imepBar: 11 }),
      makeCycleStats({ cycle: 3, imepBar: 11 }),
    ];
    const series = imepDeltaSeries(cycles);
    expect(series.map((d) => d.cycle)).toEqual([2, 3]);
    expect(series[0]!.deltaPct).toBeCloseTo(0.1, 6); // |11-10|/10
    expect(series[1]!.deltaPct).toBeCloseTo(0, 6); // |11-11|/11
  });

  it("uses the epsilon floor when the previous IMEP is ~0", () => {
    const cycles = [
      makeCycleStats({ cycle: 1, imepBar: 0 }),
      makeCycleStats({ cycle: 2, imepBar: 1 }),
    ];
    const series = imepDeltaSeries(cycles);
    // Denominator floored at ε so the ratio is finite (huge), not Infinity.
    expect(Number.isFinite(series[0]!.deltaPct)).toBe(true);
  });
});

describe("covLastN", () => {
  it("returns null with fewer than n cycles", () => {
    const cycles = [
      makeCycleStats({ cycle: 1, imepBar: 10 }),
      makeCycleStats({ cycle: 2, imepBar: 10 }),
    ];
    expect(covLastN(cycles, "imepBar", 5)).toBeNull();
  });

  it("computes coefficient of variation over the last n cycles", () => {
    // Last 5 IMEP values constant → CoV exactly 0.
    const cycles = Array.from({ length: 6 }, (_, i) =>
      makeCycleStats({ cycle: i + 1, imepBar: i < 1 ? 5 : 10 }),
    );
    expect(covLastN(cycles, "imepBar", 5)).toBeCloseTo(0, 9);
  });

  it("returns a positive CoV for a varying window", () => {
    const vals = [10, 12, 8, 11, 9];
    const cycles = vals.map((v, i) => makeCycleStats({ cycle: i + 1, imepBar: v }));
    const cov = covLastN(cycles, "imepBar", 5)!;
    // mean 10, population stdev = sqrt(((0+4+4+1+1)/5)) = sqrt(2) ≈ 1.414.
    expect(cov).toBeCloseTo(Math.sqrt(2) / 10, 6);
  });

  it("returns null when the mean is ~0 (CoV undefined)", () => {
    const cycles = [-2, -1, 0, 1, 2].map((v, i) =>
      makeCycleStats({ cycle: i + 1, imepBar: v }),
    );
    expect(covLastN(cycles, "imepBar", 5)).toBeNull();
  });

  it("returns null when a windowed value is missing / non-finite", () => {
    // knockIntegral is optional — an absent field in the window guards to null.
    const cycles = Array.from({ length: 5 }, (_, i) =>
      makeCycleStats({ cycle: i + 1 }),
    );
    expect(covLastN(cycles, "knockIntegral", 5)).toBeNull();
  });
});

describe("maxKnockIntegral", () => {
  it("returns null when no cycle carries knockIntegral", () => {
    const cycles = [makeCycleStats({ cycle: 1 }), makeCycleStats({ cycle: 2 })];
    expect(maxKnockIntegral(cycles)).toBeNull();
  });

  it("returns the max knockIntegral across cycles that have it", () => {
    const cycles = [
      makeCycleStats({ cycle: 1, knockIntegral: 0.2 }),
      makeCycleStats({ cycle: 2, knockIntegral: 0.55 }),
      makeCycleStats({ cycle: 3 }),
    ];
    expect(maxKnockIntegral(cycles)).toBeCloseTo(0.55, 6);
  });
});
