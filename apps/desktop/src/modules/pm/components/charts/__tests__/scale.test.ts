import { describe, expect, it } from "vitest";
import { dayToColumn, labelIndices, niceTicks } from "../scale";

describe("niceTicks", () => {
  it("rounds a peak of 9 up to 10 with 5-step ticks", () => {
    expect(niceTicks(9)).toEqual({ max: 10, ticks: [0, 5, 10] });
  });
  it("never yields more than maxTicks gridlines", () => {
    for (const v of [1, 3, 7, 13, 41, 99, 250, 1234]) {
      const { ticks, max } = niceTicks(v, 4);
      expect(ticks.length - 1).toBeLessThanOrEqual(4);
      expect(max).toBeGreaterThanOrEqual(v);
    }
  });
  it("treats zero as a one-unit axis so an empty chart still has a scale", () => {
    expect(niceTicks(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe("labelIndices", () => {
  it("labels every column when they fit", () => {
    expect([...labelIndices(4, 60, 40)].sort()).toEqual([0, 1, 2, 3]);
  });
  it("always keeps the last column and strides backwards from it", () => {
    const idx = labelIndices(10, 20, 40); // stride 2
    expect(idx.has(9)).toBe(true);
    expect(idx.has(8)).toBe(false);
    expect(idx.has(7)).toBe(true);
    expect(idx.has(1)).toBe(true);
    expect(idx.has(0)).toBe(false);
  });
  it("is empty for no columns", () => {
    expect(labelIndices(0, 20, 40).size).toBe(0);
  });
});

describe("dayToColumn", () => {
  const weeks = ["2026-08-31", "2026-09-07", "2026-09-14"];
  it("places a Monday at its column's left edge", () => {
    expect(dayToColumn("2026-09-07", weeks)).toBe(1);
  });
  it("places a mid-week day fractionally inside its column", () => {
    expect(dayToColumn("2026-09-10", weeks)).toBeCloseTo(1 + 3 / 7);
  });
  it("returns null outside the strip", () => {
    expect(dayToColumn("2026-08-30", weeks)).toBeNull();
    expect(dayToColumn("2026-09-22", weeks)).toBeNull();
    expect(dayToColumn("2026-09-21", weeks)).toBe(3); // right edge, inclusive
  });
});
