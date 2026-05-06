import { describe, it, expect } from "vitest";
import { mean, stddev, correlation, percentile, linspace } from "../src/statistics";

describe("statistics", () => {
  it("mean ignores NaN", () => {
    expect(mean([1, 2, NaN, 4])).toBeCloseTo((1 + 2 + 4) / 3, 8);
  });
  it("mean of empty / all-NaN is NaN", () => {
    expect(mean([])).toBeNaN();
    expect(mean([NaN, NaN])).toBeNaN();
  });
  it("stddev of [2,4,4,4,5,5,7,9] is 2.138 (sample, n-1)", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
  it("correlation of identical arrays is 1", () => {
    expect(correlation([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 8);
  });
  it("correlation of negated arrays is -1", () => {
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 8);
  });
  it("percentile interpolates between samples", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBeCloseTo(3, 8);
    expect(percentile([1, 2, 3, 4, 5], 25)).toBeCloseTo(2, 8);
    expect(percentile([1, 2, 3, 4, 5], 75)).toBeCloseTo(4, 8);
  });
  it("linspace produces n evenly-spaced values from lo to hi inclusive", () => {
    const ls = linspace(0, 10, 5);
    expect(Array.from(ls)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});
