import { describe, it, expect } from "vitest";
import { fitLinear } from "../src/regression";

describe("fitLinear", () => {
  it("recovers exact slope + intercept for a perfect line", () => {
    // y = 3x + 1
    const xs = [0, 1, 2, 3, 4];
    const ys = [1, 4, 7, 10, 13];
    const fit = fitLinear(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(1, 8);   // intercept
    expect(fit.coefficients[1]).toBeCloseTo(3, 8);   // slope
    expect(fit.rSquared).toBeCloseTo(1, 8);
    expect(fit.residualStd).toBeCloseTo(0, 8);
    expect(fit.predict(5)).toBeCloseTo(16, 8);
  });

  it("returns R²=0 for a constant Y", () => {
    const xs = [0, 1, 2, 3];
    const ys = [5, 5, 5, 5];
    const fit = fitLinear(xs, ys);
    expect(fit.rSquared).toBeCloseTo(0, 8);
  });

  it("skips NaN samples", () => {
    const xs = [0, 1, NaN, 3, 4];
    const ys = [1, 4, 99,  10, 13];
    const fit = fitLinear(xs, ys);
    expect(fit.coefficients[1]).toBeCloseTo(3, 4);
    expect(fit.validSamples).toBe(4);
  });
});
