import { describe, it, expect } from "vitest";
import { computeLapDelta, formatDelta } from "../src/lap-delta/compute";

/** Synthesize a lap: linear motion with constant speed over `lapDurationS`.
 *  Returns time/dist arrays plus the lap boundaries usable as inputs to
 *  computeLapDelta. Distance is integrated at `speedMps` m/s. */
function makeLap(opts: {
  startUs: number;
  durationS: number;
  speedMps: number;
  sampleHz: number;
}): { time: BigInt64Array; dist: Float64Array; startUs: number; endUs: number } {
  const n = Math.round(opts.durationS * opts.sampleHz) + 1;
  const time = new BigInt64Array(n);
  const dist = new Float64Array(n);
  const dtS = 1 / opts.sampleHz;
  for (let i = 0; i < n; i++) {
    const tS = i * dtS;
    time[i] = BigInt(opts.startUs + Math.round(tS * 1_000_000));
    dist[i] = tS * opts.speedMps;
  }
  return { time, dist, startUs: opts.startUs, endUs: opts.startUs + opts.durationS * 1_000_000 };
}

describe("computeLapDelta", () => {
  it("returns null when Main lap has no samples", () => {
    const empty = { time: new BigInt64Array(0), dist: new Float64Array(0), startUs: 0, endUs: 100 };
    const ref = makeLap({ startUs: 0, durationS: 10, speedMps: 10, sampleHz: 10 });
    const r = computeLapDelta({
      mainTimeUs: empty.time, mainDist: empty.dist, mainLapStartUs: empty.startUs, mainLapEndUs: empty.endUs,
      refTimeUs: ref.time, refDist: ref.dist, refLapStartUs: ref.startUs, refLapEndUs: ref.endUs,
    });
    expect(r).toBeNull();
  });

  it("identical Main and Ref → delta is zero everywhere", () => {
    const main = makeLap({ startUs: 0, durationS: 10, speedMps: 10, sampleHz: 50 });
    // Ref same shape, offset session start so absolute time differs.
    const ref = makeLap({ startUs: 1_000_000_000, durationS: 10, speedMps: 10, sampleHz: 50 });
    const r = computeLapDelta({
      mainTimeUs: main.time, mainDist: main.dist, mainLapStartUs: main.startUs, mainLapEndUs: main.endUs,
      refTimeUs: ref.time, refDist: ref.dist, refLapStartUs: ref.startUs, refLapEndUs: ref.endUs,
    })!;
    expect(r).not.toBeNull();
    for (let i = 0; i < r.deltaS.length; i++) {
      expect(Math.abs(r.deltaS[i]!)).toBeLessThan(1e-6);
    }
    expect(Math.abs(r.finalDeltaS)).toBeLessThan(1e-6);
  });

  it("Main slower than Ref → positive delta, growing roughly linearly with distance", () => {
    // Main 10 m/s, Ref 20 m/s over the same 200m of lap.
    // At distance d, Main has spent d/10 s, Ref has spent d/20 s, Δ = d/20.
    // At d=100: Δ = 5s. At d=200: Δ = 10s.
    const main = makeLap({ startUs: 0, durationS: 20, speedMps: 10, sampleHz: 50 });
    const ref  = makeLap({ startUs: 0, durationS: 10, speedMps: 20, sampleHz: 50 });
    const r = computeLapDelta({
      mainTimeUs: main.time, mainDist: main.dist, mainLapStartUs: main.startUs, mainLapEndUs: main.endUs,
      refTimeUs: ref.time, refDist: ref.dist, refLapStartUs: ref.startUs, refLapEndUs: ref.endUs,
    })!;
    expect(r).not.toBeNull();
    // Find sample where Main has reached ~100m and check delta ≈ 5s.
    const idx100 = r.distance.findIndex((d) => d >= 99 && d <= 101);
    expect(idx100).toBeGreaterThanOrEqual(0);
    expect(r.deltaS[idx100]!).toBeGreaterThan(4.9);
    expect(r.deltaS[idx100]!).toBeLessThan(5.1);
    // At Main's max distance (200m), Ref also reached 200m at t=10s; Main at t=20s; Δ=10s.
    expect(r.finalDeltaS).toBeGreaterThan(9.9);
    expect(r.finalDeltaS).toBeLessThan(10.1);
  });

  it("Main faster than Ref → negative delta", () => {
    const main = makeLap({ startUs: 0, durationS: 10, speedMps: 20, sampleHz: 50 });
    const ref  = makeLap({ startUs: 0, durationS: 20, speedMps: 10, sampleHz: 50 });
    const r = computeLapDelta({
      mainTimeUs: main.time, mainDist: main.dist, mainLapStartUs: main.startUs, mainLapEndUs: main.endUs,
      refTimeUs: ref.time, refDist: ref.dist, refLapStartUs: ref.startUs, refLapEndUs: ref.endUs,
    })!;
    expect(r.finalDeltaS).toBeLessThan(-9.9);
    expect(r.finalDeltaS).toBeGreaterThan(-10.1);
  });

  it("Main goes further than Ref → delta is NaN past Ref's max distance", () => {
    // Main covers 200m, Ref only covers 100m. Past 100m on Main, no Ref data.
    const main = makeLap({ startUs: 0, durationS: 20, speedMps: 10, sampleHz: 50 });
    const ref  = makeLap({ startUs: 0, durationS: 10, speedMps: 10, sampleHz: 50 });
    const r = computeLapDelta({
      mainTimeUs: main.time, mainDist: main.dist, mainLapStartUs: main.startUs, mainLapEndUs: main.endUs,
      refTimeUs: ref.time, refDist: ref.dist, refLapStartUs: ref.startUs, refLapEndUs: ref.endUs,
    })!;
    // The last sample is at 200m which is beyond Ref's 100m → NaN.
    expect(r.deltaS[r.deltaS.length - 1]!).toBeNaN();
    // The final delta should be the last finite delta — which happens at ~100m
    // where Main has spent 10s and Ref spent 10s → 0.
    expect(Math.abs(r.finalDeltaS)).toBeLessThan(0.5);
  });
});

describe("formatDelta", () => {
  it("renders signed, 2-decimal seconds with explicit + sign", () => {
    expect(formatDelta(1.234)).toBe("+1.23s");
    expect(formatDelta(-0.5)).toBe("−0.50s");
    expect(formatDelta(0)).toBe("0.00s");
  });
  it("renders em-dash for non-finite", () => {
    expect(formatDelta(NaN)).toBe("—");
    expect(formatDelta(Infinity)).toBe("—");
  });
});
