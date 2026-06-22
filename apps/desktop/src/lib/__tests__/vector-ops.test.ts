/** Regression tests for vector-ops.ts — focused on the derivative()
 *  divide-by-zero bug on duplicate adjacent timestamps. */

import { describe, it, expect } from "vitest";
import { derivative } from "../vector-ops";

function toTimeUs(secondsArr: number[]): BigInt64Array {
  return BigInt64Array.from(secondsArr.map((s) => BigInt(Math.round(s * 1_000_000))));
}

describe("derivative()", () => {
  it("returns NaN (not Infinity) for duplicate adjacent timestamps at i=0", () => {
    const values = new Float64Array([1, 2, 3]);
    // t0 === t1 — forward difference would divide by zero
    const timeUs = toTimeUs([0, 0, 1]);
    const out = derivative(values, timeUs);
    expect(out[0]).toBeNaN();
    // Interior and last sample are still computable
    expect(Number.isFinite(out[1]!)).toBe(true);
    expect(Number.isFinite(out[2]!)).toBe(true);
  });

  it("returns NaN (not Infinity) for a zero-delta central difference (interior)", () => {
    // A central difference at index i spans t[i-1]..t[i+1]; it only divides by
    // zero when those two are equal. Three equal adjacent timestamps make i=2
    // such a case, so out[2] must be NaN while the normal interior points
    // (out[1] and out[3], each dt=1) stay finite.
    const values = new Float64Array([0, 1, 2, 3, 4]);
    const timeUs = toTimeUs([0, 1, 1, 1, 2]);
    const out = derivative(values, timeUs);
    expect(out[2]).toBeNaN();
    expect(Number.isFinite(out[1]!)).toBe(true);
    expect(Number.isFinite(out[3]!)).toBe(true);
  });

  it("returns NaN (not Infinity) for duplicate adjacent timestamps at i=N-1", () => {
    const values = new Float64Array([1, 2, 3]);
    const timeUs = toTimeUs([0, 1, 1]); // t[N-2] === t[N-1]
    const out = derivative(values, timeUs);
    expect(out[2]).toBeNaN();
  });

  it("computes correct derivative for uniform time steps", () => {
    // f(t) = 2t → f'(t) = 2 everywhere
    const values = new Float64Array([0, 2, 4, 6, 8]);
    const timeUs = toTimeUs([0, 1, 2, 3, 4]);
    const out = derivative(values, timeUs);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(2.0, 6);
    }
  });

  it("returns a single NaN for a length-1 array", () => {
    const out = derivative(new Float64Array([42]), BigInt64Array.from([0n]));
    expect(out[0]).toBeNaN();
  });

  it("returns empty array for length-0 input", () => {
    const out = derivative(new Float64Array([]), new BigInt64Array([]));
    expect(out.length).toBe(0);
  });
});
