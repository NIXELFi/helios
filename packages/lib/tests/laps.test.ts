import { describe, it, expect } from "vitest";
import { lapIndexAt, lapAggregate, detectLaps } from "../src/laps";
import type { LapSet, Lap } from "../src/laps";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLap(index: number, startUs: number, endUs: number, trusted = true): Lap {
  return {
    index,
    startUs,
    endUs,
    durationS: (endUs - startUs) / 1_000_000,
    distanceM: NaN,
    trusted,
  };
}

function makeSet(laps: Lap[]): LapSet {
  return { laps, bestLapIndex: 0, cacheKey: "test" };
}

// ─── lapIndexAt ───────────────────────────────────────────────────────────────

describe("lapIndexAt", () => {
  it("returns -1 for empty set", () => {
    expect(lapIndexAt(makeSet([]), 1_000_000)).toBe(-1);
  });

  it("returns correct index within a lap", () => {
    const set = makeSet([
      makeLap(1, 0, 10_000_000),
      makeLap(2, 10_000_000, 20_000_000),
    ]);
    expect(lapIndexAt(set, 5_000_000)).toBe(0);
    expect(lapIndexAt(set, 15_000_000)).toBe(1);
  });

  it("returns -1 for timestamp before the first lap (regression: was returning last-lap index)", () => {
    const set = makeSet([
      makeLap(1, 5_000_000, 15_000_000),
    ]);
    // tUs=0 is before the first lap's startUs; must be -1, not 0.
    expect(lapIndexAt(set, 0)).toBe(-1);
    expect(lapIndexAt(set, 4_999_999)).toBe(-1);
  });

  it("returns last-lap index for the exact endUs boundary (tail-inclusive)", () => {
    const set = makeSet([
      makeLap(1, 0, 10_000_000),
    ]);
    expect(lapIndexAt(set, 10_000_000)).toBe(0);
  });

  it("returns -1 for timestamp beyond the last lap", () => {
    const set = makeSet([
      makeLap(1, 0, 10_000_000),
    ]);
    expect(lapIndexAt(set, 10_000_001)).toBe(-1);
  });
});

// ─── lapAggregate ─────────────────────────────────────────────────────────────

describe("lapAggregate — boundary sample exclusion", () => {
  it("does NOT include the lap-end boundary sample in the current lap's aggregate (regression)", () => {
    // Two back-to-back laps. The boundary sample at t=10s belongs to neither
    // lap (it's the start of the next). lapAggregate must not attribute it to
    // the first lap — otherwise max for lap-1 would spuriously include the
    // boundary value.
    const lap1 = makeLap(1, 0, 10_000_000);
    const lap2 = makeLap(2, 10_000_000, 20_000_000);
    const set = makeSet([lap1, lap2]);

    // Values: lap1 contains [1,2,3] at t=0,5,9s. t=10s (value=99) is the
    // boundary and must be credited to lap2 only.
    const timeUs = BigInt64Array.from([0n, 5_000_000n, 9_000_000n, 10_000_000n, 15_000_000n]);
    const values = Float64Array.from([1, 2, 3, 99, 4]);

    const result = lapAggregate("lap_max", values, timeUs, set);

    // Every sample in lap1 (t<10s) should get max=3. t=10s sample should get
    // max=99 (from lap2).
    expect(result[0]).toBe(3);  // t=0 → lap1 max
    expect(result[1]).toBe(3);  // t=5 → lap1 max
    expect(result[2]).toBe(3);  // t=9 → lap1 max
    expect(result[3]).toBe(99); // t=10 → lap2 max (boundary belongs to lap2)
  });
});

// ─── detectLaps / no-crossing fallback ────────────────────────────────────────

describe("detectLaps — empty inputs", () => {
  it("returns empty LapSet for mode:none", () => {
    const result = detectLaps(
      { mode: "none" },
      {
        timeUs: BigInt64Array.from([0n, 1_000_000n]),
        resolve: () => undefined,
        unitsOf: () => undefined,
      },
    );
    expect(result.laps).toHaveLength(0);
    expect(result.bestLapIndex).toBe(-1);
  });
});
