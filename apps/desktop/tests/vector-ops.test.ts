import { describe, it, expect } from "vitest";
import { derivative, integral, shift, smooth, lowpass } from "../src/lib/vector-ops";

/** Build a uniformly-spaced timestamp array, in microseconds. */
function timeUs(n: number, dtSeconds: number): BigInt64Array {
  const t = new BigInt64Array(n);
  for (let i = 0; i < n; i++) t[i] = BigInt(Math.round(i * dtSeconds * 1_000_000));
  return t;
}

describe("derivative", () => {
  it("constant signal → zero derivative", () => {
    const v = new Float64Array([5, 5, 5, 5, 5]);
    const out = derivative(v, timeUs(5, 0.01));
    for (const x of out) expect(x).toBeCloseTo(0);
  });

  it("linear ramp at 100 Hz → constant slope", () => {
    // y = 2t at 100Hz; dy/dt = 2
    const dt = 0.01;
    const v = new Float64Array(11);
    for (let i = 0; i < 11; i++) v[i] = 2 * i * dt;
    const out = derivative(v, timeUs(11, dt));
    // Forward at i=0
    expect(out[0]).toBeCloseTo(2);
    // Central in interior
    for (let i = 1; i < 10; i++) expect(out[i]).toBeCloseTo(2);
    // Backward at end
    expect(out[10]).toBeCloseTo(2);
  });
});

describe("integral", () => {
  it("constant 1 over 1 s → integral reaches 1", () => {
    const dt = 0.01;
    const n = 101;
    const v = new Float64Array(n).fill(1);
    const out = integral(v, timeUs(n, dt));
    expect(out[0]).toBe(0);
    expect(out[n - 1]).toBeCloseTo(1, 5);
  });

  it("trapezoidal area under triangle", () => {
    // y = t, integral over 0..1 = 0.5
    const dt = 0.01;
    const n = 101;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = i * dt;
    const out = integral(v, timeUs(n, dt));
    expect(out[n - 1]).toBeCloseTo(0.5, 4);
  });

  it("NaN inputs emit NaN at that sample but don't propagate", () => {
    // Constant 1 with one NaN gap: dt=1s, values [1, 1, NaN, 1, 1]
    // Expected output: [0, 1, NaN, 2, 3]
    //   i=0: 0 (base)
    //   i=1: 0 + 0.5*(1+1)*1 = 1
    //   i=2: NaN at sample, acc stays at 1
    //   i=3: NaN gap contributes nothing; resume from acc=1, add nothing for
    //        the NaN->1 step (prevV NaN), so acc stays 1
    //   i=4: 1 + 0.5*(1+1)*1 = 2... wait — at i=3 prevV becomes 1 again, so
    //        the i=3->i=4 step adds 0.5*(1+1)*1 = 1 → out[4] = 2
    // Net: the NaN sample drops one trapezoid (the i=2->i=3 contribution),
    // which matches "starting fresh from the next valid value (not propagating)".
    const v = new Float64Array([1, 1, NaN, 1, 1]);
    const out = integral(v, timeUs(5, 1));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1);
    expect(Number.isNaN(out[2]!)).toBe(true);
    expect(out[3]).toBeCloseTo(1);
    expect(out[4]).toBeCloseTo(2);
  });

  it("NaN as the first sample emits NaN at index 0", () => {
    const v = new Float64Array([NaN, 1, 1]);
    const out = integral(v, timeUs(3, 1));
    expect(Number.isNaN(out[0]!)).toBe(true);
    // i=1 is a valid sample but the gap from NaN doesn't contribute; acc=0
    expect(out[1]).toBeCloseTo(0);
    // i=2: acc += 0.5*(1+1)*1 = 1
    expect(out[2]).toBeCloseTo(1);
  });
});

describe("shift", () => {
  it("dt=0 returns the same array", () => {
    const v = new Float64Array([1, 2, 3, 4, 5]);
    const out = shift(v, timeUs(5, 0.01), 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("positive dt looks back in time → leading edge becomes NaN", () => {
    const v = new Float64Array([10, 20, 30, 40, 50]);
    // shift forward by one sample (0.01s); each output reads from one sample earlier
    const out = shift(v, timeUs(5, 0.01), 0.01);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(out[1]).toBe(10);
    expect(out[2]).toBe(20);
  });

  it("negative dt looks forward → trailing edge becomes NaN", () => {
    const v = new Float64Array([10, 20, 30, 40, 50]);
    const out = shift(v, timeUs(5, 0.01), -0.01);
    expect(out[0]).toBe(20);
    expect(out[1]).toBe(30);
    expect(Number.isNaN(out[4]!)).toBe(true);
  });
});

describe("smooth", () => {
  it("window 1 returns input", () => {
    const v = new Float64Array([1, 2, 3, 4, 5]);
    const out = smooth(v, 1);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("window 3 averages neighbors, NaN at edges", () => {
    const v = new Float64Array([10, 20, 30, 40, 50]);
    const out = smooth(v, 3);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(out[1]).toBeCloseTo(20);
    expect(out[2]).toBeCloseTo(30);
    expect(out[3]).toBeCloseTo(40);
    expect(Number.isNaN(out[4]!)).toBe(true);
  });

  it("even window is floored to odd", () => {
    const v = new Float64Array([1, 2, 3, 4, 5]);
    const a = smooth(v, 2); // -> window=1
    expect(Array.from(a)).toEqual([1, 2, 3, 4, 5]);
    const b = smooth(v, 4); // -> window=3
    expect(Number.isNaN(b[0]!)).toBe(true);
    expect(b[2]).toBeCloseTo(3);
  });
});

describe("lowpass", () => {
  it("attenuates a step input over time", () => {
    const v = new Float64Array(50).fill(1);
    v[0] = 0;
    // 100 Hz sample rate, 1 Hz cutoff → strong smoothing
    const out = lowpass(v, 1, 100);
    // First sample preserved
    expect(out[0]).toBe(0);
    // Output rises monotonically toward 1
    for (let i = 1; i < 30; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });

  it("non-positive fc passes through unchanged", () => {
    const v = new Float64Array([1, 2, 3, 4, 5]);
    const out = lowpass(v, 0, 100);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
});
