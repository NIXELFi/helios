import { describe, it, expect } from "vitest";
import { fitLinear, fitPolynomial, fitExponential, fitLogarithmic, fitPower } from "../src/regression";

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

describe("fitPolynomial", () => {
  it("recovers a quadratic exactly", () => {
    // y = 1 + 2x + 3x²
    const xs = [-2, -1, 0, 1, 2, 3];
    const ys = xs.map((x) => 1 + 2 * x + 3 * x * x);
    const fit = fitPolynomial(xs, ys, 2);
    expect(fit.coefficients[0]).toBeCloseTo(1, 6);
    expect(fit.coefficients[1]).toBeCloseTo(2, 6);
    expect(fit.coefficients[2]).toBeCloseTo(3, 6);
    expect(fit.rSquared).toBeCloseTo(1, 6);
    expect(fit.predict(4)).toBeCloseTo(1 + 8 + 48, 6);
  });

  it("returns no-fit when fewer samples than degree+1", () => {
    const fit = fitPolynomial([0, 1], [0, 1], 3);
    expect(fit.coefficients).toEqual([]);
    expect(fit.validSamples).toBe(2);
  });
});

describe("fitExponential", () => {
  it("recovers y = 2 · e^(0.5·x)", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 2 * Math.exp(0.5 * x));
    const fit = fitExponential(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(2, 4);
    expect(fit.coefficients[1]).toBeCloseTo(0.5, 4);
    expect(fit.rSquared).toBeCloseTo(1, 4);
  });
  it("skips non-positive y samples", () => {
    const fit = fitExponential([0, 1, 2], [1, -3, 7.389056]);
    expect(fit.validSamples).toBe(2);
  });
});

describe("fitLogarithmic", () => {
  it("recovers y = 1 + 2·ln(x)", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 1 + 2 * Math.log(x));
    const fit = fitLogarithmic(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(1, 4);
    expect(fit.coefficients[1]).toBeCloseTo(2, 4);
  });
  it("skips non-positive x samples", () => {
    const fit = fitLogarithmic([0, 1, 2.718281828], [99, 1, 2]);
    expect(fit.validSamples).toBe(2);
  });
});

describe("fitPower", () => {
  it("recovers y = 3 · x^2", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 * Math.pow(x, 2));
    const fit = fitPower(xs, ys);
    expect(fit.coefficients[0]).toBeCloseTo(3, 4);
    expect(fit.coefficients[1]).toBeCloseTo(2, 4);
  });
});
