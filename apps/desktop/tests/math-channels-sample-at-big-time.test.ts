import { describe, it, expect } from "vitest";
import { sampleAtBigTime } from "../src/lib/math-channels";

/** sampleAtBigTime is the cross-rate-group lookup used by applyMathChannels.
 *  It must return NaN when the requested time is before the dep's first
 *  sample so widgets render real data gaps rather than silently snapping to
 *  values[0]. */
describe("sampleAtBigTime", () => {
  const times = new BigInt64Array([100n, 200n, 300n, 400n]);
  const values = new Float64Array([10, 20, 30, 40]);

  it("returns the value at an exact sample time", () => {
    expect(sampleAtBigTime(times, values, 200n)).toBe(20);
    expect(sampleAtBigTime(times, values, 400n)).toBe(40);
  });

  it("returns the value at the largest sample ≤ t (step-hold semantics)", () => {
    expect(sampleAtBigTime(times, values, 150n)).toBe(10);
    expect(sampleAtBigTime(times, values, 250n)).toBe(20);
    expect(sampleAtBigTime(times, values, 350n)).toBe(30);
  });

  it("returns the last value for times past the end", () => {
    expect(sampleAtBigTime(times, values, 500n)).toBe(40);
  });

  it("returns NaN for times before the first sample (underflow → real gap)", () => {
    expect(Number.isNaN(sampleAtBigTime(times, values, 0n))).toBe(true);
    expect(Number.isNaN(sampleAtBigTime(times, values, 99n))).toBe(true);
  });

  it("returns the first value at exactly times[0]", () => {
    expect(sampleAtBigTime(times, values, 100n)).toBe(10);
  });

  it("returns NaN on empty input regardless of t", () => {
    const empty = new BigInt64Array(0);
    const emptyV = new Float64Array(0);
    expect(Number.isNaN(sampleAtBigTime(empty, emptyV, 0n))).toBe(true);
    expect(Number.isNaN(sampleAtBigTime(empty, emptyV, 100n))).toBe(true);
  });
});
