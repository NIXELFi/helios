import { describe, it, expect } from "vitest";
import { zoneBounds, aggregateZone, emptyZoneAgg } from "../src/zone-stats/compute";

/** 0, 100, 200, ... µs — 10 samples spanning [0, 900]. */
function timeAxis(n: number, stepUs = 100, startUs = 0): BigInt64Array {
  const t = new BigInt64Array(n);
  for (let i = 0; i < n; i++) t[i] = BigInt(startUs + i * stepUs);
  return t;
}

/** Reference implementation: the linear scan the binary search replaced, stated
 *  as the set of indices it visits. Comparing index sets rather than (lo, hi)
 *  keeps the two agreeing on *which samples are in the window* without pinning
 *  where an empty range parks its cursor. */
function linearIndices(time: BigInt64Array, startUs: number, endUs: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const t = Number(time[i]!);
    if (t < startUs) continue;
    if (t > endUs) break;
    idx.push(i);
  }
  return idx;
}

function boundsIndices(time: BigInt64Array, startUs: number, endUs: number): number[] {
  const { lo, hi } = zoneBounds(time, startUs, endUs);
  const idx: number[] = [];
  for (let i = lo; i < hi; i++) idx.push(i);
  return idx;
}

describe("zoneBounds()", () => {
  it("finds the window inside the data", () => {
    const t = timeAxis(10); // 0..900
    expect(zoneBounds(t, 250, 550)).toEqual({ lo: 3, hi: 6 }); // 300,400,500
  });

  it("includes samples sitting exactly on both boundaries", () => {
    const t = timeAxis(10);
    // 300 and 500 are real timestamps — both ends are inclusive.
    const { lo, hi } = zoneBounds(t, 300, 500);
    expect(lo).toBe(3);
    expect(hi).toBe(6);
    expect(Number(t[lo]!)).toBe(300);
    expect(Number(t[hi - 1]!)).toBe(500);
  });

  it("returns an empty range for a window that lands between samples", () => {
    const t = timeAxis(10);
    const { lo, hi } = zoneBounds(t, 310, 390); // strictly between 300 and 400
    expect(hi).toBe(lo);
  });

  it("returns an empty range for a zero-width window off-sample", () => {
    const t = timeAxis(10);
    const { lo, hi } = zoneBounds(t, 350, 350);
    expect(hi - lo).toBe(0);
  });

  it("returns a single sample for a zero-width window on a sample", () => {
    const t = timeAxis(10);
    expect(zoneBounds(t, 400, 400)).toEqual({ lo: 4, hi: 5 });
  });

  it("returns an empty range when the window is entirely before the data", () => {
    const t = timeAxis(10, 100, 1_000); // 1000..1900
    const { lo, hi } = zoneBounds(t, 0, 500);
    expect(hi - lo).toBe(0);
    expect(lo).toBe(0);
  });

  it("returns an empty range when the window is entirely after the data", () => {
    const t = timeAxis(10); // 0..900
    const { lo, hi } = zoneBounds(t, 5_000, 9_000);
    expect(hi - lo).toBe(0);
    expect(lo).toBe(10);
  });

  it("clamps a window that overhangs both ends to the whole array", () => {
    const t = timeAxis(10);
    expect(zoneBounds(t, -5_000, 5_000)).toEqual({ lo: 0, hi: 10 });
  });

  it("returns an empty range for an inverted window (end < start)", () => {
    const t = timeAxis(10);
    const { lo, hi } = zoneBounds(t, 600, 200);
    expect(hi - lo).toBe(0);
  });

  it("handles an empty time axis", () => {
    expect(zoneBounds(new BigInt64Array(0), 0, 100)).toEqual({ lo: 0, hi: 0 });
  });

  it("honours the `n` clamp for a shorter value array", () => {
    const t = timeAxis(10);
    // Only the first 5 samples (0..400) are backed by values.
    expect(zoneBounds(t, 0, 900, 5)).toEqual({ lo: 0, hi: 5 });
  });

  it("accepts fractional µs bounds (cursor positions are not integers)", () => {
    const t = timeAxis(10);
    expect(zoneBounds(t, 299.5, 500.5)).toEqual({ lo: 3, hi: 6 });
  });

  it("selects the same samples as the linear scan across randomized windows", () => {
    const t = timeAxis(64, 100); // 0..6300
    for (let k = 0; k < 400; k++) {
      const a = Math.round(Math.random() * 7_000) - 200;
      const b = Math.round(Math.random() * 7_000) - 200;
      const startUs = Math.min(a, b), endUs = Math.max(a, b);
      expect({ startUs, endUs, idx: boundsIndices(t, startUs, endUs) })
        .toEqual({ startUs, endUs, idx: linearIndices(t, startUs, endUs) });
    }
  });
});

describe("aggregateZone()", () => {
  it("aggregates only the samples inside the window", () => {
    const t = timeAxis(10);
    const v = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const a = aggregateZone(v, t, 300, 500); // indices 3,4,5
    expect(a.n).toBe(3);
    expect(a.start).toBe(3);
    expect(a.end).toBe(5);
    expect(a.min).toBe(3);
    expect(a.max).toBe(5);
    expect(a.sum).toBe(12);
    expect(a.durationS).toBeCloseTo(0.0002, 12);
  });

  it("skips non-finite samples without ending the window", () => {
    const t = timeAxis(10);
    const v = Float64Array.from([0, 1, 2, NaN, 4, 5, 6, 7, 8, 9]);
    const a = aggregateZone(v, t, 300, 500);
    expect(a.n).toBe(2);
    expect(a.start).toBe(4); // the NaN at index 3 is skipped, not treated as start
    expect(a.end).toBe(5);
  });

  it("reports n=0 with the zone's own duration for an empty window", () => {
    const t = timeAxis(10);
    const v = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const a = aggregateZone(v, t, 5_000, 6_000);
    expect(a.n).toBe(0);
    expect(a.start).toBeNaN();
    expect(a.end).toBeNaN();
    expect(a.durationS).toBeCloseTo(0.001, 12);
  });

  it("clamps to the shorter of values/time", () => {
    const t = timeAxis(10);
    const v = Float64Array.from([0, 1, 2, 3, 4]); // only 5 values for 10 stamps
    const a = aggregateZone(v, t, 0, 900);
    expect(a.n).toBe(5);
    expect(a.end).toBe(4);
  });
});

describe("emptyZoneAgg()", () => {
  it("carries the zone duration with no samples", () => {
    const a = emptyZoneAgg(1_000, 3_000);
    expect(a.n).toBe(0);
    expect(a.durationS).toBeCloseTo(0.002, 12);
    expect(a.start).toBeNaN();
  });
});
