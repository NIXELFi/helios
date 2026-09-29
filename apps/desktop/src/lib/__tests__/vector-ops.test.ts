/** Regression tests for vector-ops.ts — the derivative() divide-by-zero bug on
 *  duplicate adjacent timestamps, and the highpass() NaN-gap state reset. */

import { describe, it, expect } from "vitest";
import { derivative, highpass, lowpass, smooth } from "../vector-ops";

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

const FS_HZ = 100;
const FC_HZ = 1;
const SIG_HZ = 5;

/** A 5 Hz unit sine at 100 Hz, well above the 1 Hz cutoff, so the high-passed
 *  output is a near-unit-amplitude oscillation — an injected step is obvious. */
function sine(n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * SIG_HZ * (i / FS_HZ));
  return out;
}

function withNaNAt(values: Float64Array, from: number, count = 1): Float64Array {
  const out = Float64Array.from(values);
  for (let k = 0; k < count; k++) out[from + k] = NaN;
  return out;
}

describe("highpass()", () => {
  it("propagates NaN input positions as NaN output", () => {
    const gapped = withNaNAt(sine(200), 100, 3);
    const out = highpass(gapped, FC_HZ, FS_HZ);
    expect(out[100]).toBeNaN();
    expect(out[101]).toBeNaN();
    expect(out[102]).toBeNaN();
    expect(Number.isFinite(out[99]!)).toBe(true);
    expect(Number.isFinite(out[103]!)).toBe(true);
  });

  it("holds filter state across a NaN gap instead of stepping to 0", () => {
    // The regression: resetting state to 0 at a dropout injected a step of the
    // signal's full amplitude. Held state means the samples after the gap track
    // the no-gap run closely (they differ only by the one sample of decay the
    // gap actually cost, ~(1-α) ≈ 0.06 of amplitude here).
    const clean = sine(200);
    const ref = highpass(clean, FC_HZ, FS_HZ);
    const out = highpass(withNaNAt(clean, 100), FC_HZ, FS_HZ);
    let maxDiff = 0;
    for (let i = 101; i < 200; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i]! - ref[i]!));
    expect(maxDiff).toBeLessThan(0.1);
    // Guard the assertion itself: the reference really is a full-amplitude
    // oscillation, so "close to ref" is a meaningful claim, not a tautology.
    let refAmp = 0;
    for (let i = 101; i < 200; i++) refAmp = Math.max(refAmp, Math.abs(ref[i]!));
    expect(refAmp).toBeGreaterThan(0.9);
  });

  it("does not jump toward 0 at the sample that resumes after the gap", () => {
    // Sharper form of the same check: the first finite sample after the gap
    // continues the oscillation rather than restarting the filter from zero.
    const clean = sine(200);
    const ref = highpass(clean, FC_HZ, FS_HZ);
    const out = highpass(withNaNAt(clean, 100, 2), FC_HZ, FS_HZ);
    expect(out[102]).toBeCloseTo(ref[102]!, 1);
    expect(Math.abs(out[102]!)).toBeGreaterThan(0.5 * Math.abs(ref[102]!));
  });

  it("matches the unfiltered-path result when the input has no NaNs", () => {
    // The state refactor must not change clean-data behaviour at all.
    const clean = sine(50);
    const out = highpass(clean, FC_HZ, FS_HZ);
    expect(out[0]).toBe(0);
    const alpha = Math.exp(-2 * Math.PI * FC_HZ / FS_HZ);
    let y = 0;
    for (let i = 1; i < 50; i++) {
      y = alpha * (y + clean[i]! - clean[i - 1]!);
      expect(out[i]).toBeCloseTo(y, 12);
    }
  });

  it("emits NaN (not 0) for a leading NaN and seeds on the first finite sample", () => {
    const values = Float64Array.from([NaN, NaN, 1, 2, 4]);
    const out = highpass(values, FC_HZ, FS_HZ);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(0); // first finite sample seeds the filter
    expect(Number.isFinite(out[3]!)).toBe(true);
  });

  it("holds state across NaN gaps the way lowpass does", () => {
    // Both filters must survive a dropout; neither may restart from a constant.
    const clean = sine(200);
    const gapped = withNaNAt(clean, 100);
    const lp = lowpass(gapped, FC_HZ, FS_HZ);
    const lpRef = lowpass(clean, FC_HZ, FS_HZ);
    const hp = highpass(gapped, FC_HZ, FS_HZ);
    const hpRef = highpass(clean, FC_HZ, FS_HZ);
    for (let i = 101; i < 200; i++) {
      expect(Math.abs(lp[i]! - lpRef[i]!)).toBeLessThan(0.1);
      expect(Math.abs(hp[i]! - hpRef[i]!)).toBeLessThan(0.1);
    }
  });

  it("returns empty array for length-0 input", () => {
    expect(highpass(new Float64Array([]), FC_HZ, FS_HZ).length).toBe(0);
  });
});

describe("smooth()", () => {
  /** The original O(n*w) implementation, kept as the reference semantics. */
  function naiveSmooth(values: Float64Array, window: number): Float64Array {
    const n = values.length;
    const out = new Float64Array(n);
    if (n === 0) return out;
    let w = Math.max(1, Math.floor(window));
    if (w % 2 === 0) w -= 1;
    if (w < 1) w = 1;
    if (w === 1) { out.set(values); return out; }
    const half = (w - 1) / 2;
    for (let i = 0; i < n; i++) {
      if (i < half || i + half >= n) { out[i] = NaN; continue; }
      let sum = 0;
      let count = 0;
      for (let k = i - half; k <= i + half; k++) {
        const v = values[k]!;
        if (Number.isFinite(v)) { sum += v; count++; }
      }
      out[i] = count > 0 ? sum / count : NaN;
    }
    return out;
  }

  function expectSame(a: Float64Array, b: Float64Array) {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (Number.isNaN(b[i]!)) expect(a[i], `index ${i}`).toBeNaN();
      else expect(a[i], `index ${i}`).toBeCloseTo(b[i]!, 9);
    }
  }

  // Deterministic pseudo-random data with NaN / ±Infinity holes and a long
  // all-NaN run (so some windows have count === 0).
  function makeData(n: number): Float64Array {
    const out = new Float64Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const r = seed / 2147483648;
      out[i] = r < 0.08 ? NaN : r < 0.1 ? Infinity : r < 0.11 ? -Infinity : (r - 0.5) * 200;
    }
    for (let i = 100; i < 130 && i < n; i++) out[i] = NaN;
    return out;
  }

  it("matches the naive centered average on data with NaNs for many windows", () => {
    const data = makeData(500);
    for (const w of [1, 2, 3, 4, 5, 7, 10, 11, 31, 64, 99, 499, 500, 501, 2.7, 0, -3]) {
      expectSame(smooth(data, w), naiveSmooth(data, w));
    }
  });

  it("matches on tiny arrays around the window-vs-length boundary", () => {
    for (let n = 1; n <= 8; n++) {
      const data = makeData(n);
      for (let w = 1; w <= n + 3; w++) expectSame(smooth(data, w), naiveSmooth(data, w));
    }
  });

  it("returns all-NaN quickly for a window far larger than the data", () => {
    const data = new Float64Array(200_000).fill(1);
    const t0 = performance.now();
    const out = smooth(data, 1e12);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
    expect(smooth(data, Infinity).every((v) => Number.isNaN(v))).toBe(true);
  });

  it("is O(n) for a large window that still fits the data", () => {
    const data = makeData(400_000);
    const t0 = performance.now();
    const out = smooth(data, 200_001);
    expect(performance.now() - t0).toBeLessThan(1000);
    // The center sample's window spans [0, 200_000] — compare to the naive
    // result computed on exactly that slice.
    const naive = naiveSmooth(data.subarray(0, 200_001), 200_001);
    expect(out[100_000]).toBeCloseTo(naive[100_000]!, 6);
  });

  it("does not drift after a huge value leaves the window", () => {
    const data = new Float64Array(1000).fill(1);
    data[10] = 1e20;
    const out = smooth(data, 5);
    for (let i = 20; i < 998; i++) expect(out[i]).toBe(1);
  });
});
