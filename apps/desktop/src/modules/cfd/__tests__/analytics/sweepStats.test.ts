import { describe, expect, it } from "vitest";
import {
  peakOf,
  powerbandWidth,
  summarizeSweep,
} from "../../lib/analytics/sweepStats";
import { makeSweepPoint } from "../fakes/study";

const power = (p: { lastCycle: { brakePowerKW: number } }) => p.lastCycle.brakePowerKW;

describe("peakOf", () => {
  it("returns null on empty input", () => {
    expect(peakOf([], power)).toBeNull();
  });

  it("uses the sampled point as interp when <3 points", () => {
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
    ];
    const peak = peakOf(pts, power);
    expect(peak).not.toBeNull();
    expect(peak!.rpm).toBe(10000);
    expect(peak!.value).toBe(64);
    expect(peak!.rpmInterp).toBe(10000);
    expect(peak!.valueInterp).toBe(64);
  });

  it("interpolates a symmetric interior parabola vertex at the center rpm", () => {
    // Symmetric concave-down triple → vertex sits exactly at the middle rpm,
    // and the interpolated value equals the sampled middle value.
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 60 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 60 } }),
    ];
    const peak = peakOf(pts, power)!;
    expect(peak.rpm).toBe(10000);
    expect(peak.rpmInterp).toBeCloseTo(10000, 3);
    expect(peak.valueInterp).toBeCloseTo(64, 6);
  });

  it("shifts an asymmetric interior vertex but keeps it within the neighbor window", () => {
    // Right neighbor higher than left → vertex pulled toward the right side,
    // and interp value exceeds the sampled max.
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 58 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 62 } }),
    ];
    const peak = peakOf(pts, power)!;
    expect(peak.rpm).toBe(10000);
    expect(peak.rpmInterp).toBeGreaterThan(10000);
    expect(peak.rpmInterp).toBeLessThanOrEqual(12000);
    expect(peak.valueInterp).toBeGreaterThanOrEqual(64);
  });

  it("falls back to the sample when the max is at an edge", () => {
    // Monotone rising → max is the rightmost (edge) point, no interpolation.
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 58 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 64 } }),
    ];
    const peak = peakOf(pts, power)!;
    expect(peak.rpm).toBe(12000);
    expect(peak.rpmInterp).toBe(12000);
    expect(peak.valueInterp).toBe(64);
  });

  it("sorts unsorted points before locating the peak", () => {
    const pts = [
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 60 } }),
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 60 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
    ];
    const peak = peakOf(pts, power)!;
    expect(peak.rpm).toBe(10000);
    expect(peak.rpmInterp).toBeCloseTo(10000, 3);
  });
});

describe("powerbandWidth", () => {
  it("returns null with fewer than 2 points", () => {
    expect(powerbandWidth([makeSweepPoint({ rpm: 10000 })])).toBeNull();
    expect(powerbandWidth([])).toBeNull();
  });

  it("interpolates band crossings around the peak", () => {
    // Peak 100 at 10000; threshold 95. Left segment 90→100 crosses at half;
    // right segment 100→90 crosses at half → symmetric band around peak.
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 90 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 100 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 90 } }),
    ];
    const band = powerbandWidth(pts, 0.95)!;
    expect(band.fromRpm).toBeCloseTo(9000, 3);
    expect(band.toRpm).toBeCloseTo(11000, 3);
    expect(band.widthRpm).toBeCloseTo(2000, 3);
  });

  it("uses endpoints when they are already above threshold", () => {
    // Flat curve → every point is the peak; band spans the full rpm range.
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 64 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 64 } }),
    ];
    const band = powerbandWidth(pts, 0.95)!;
    expect(band.fromRpm).toBe(8000);
    expect(band.toRpm).toBe(12000);
    expect(band.widthRpm).toBe(4000);
  });
});

describe("summarizeSweep", () => {
  it("rolls up peaks and powerband for a complete sweep", () => {
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50, brakeTorqueNm: 59.7, veAtm: 0.90 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64, brakeTorqueNm: 61.1, veAtm: 0.96 } }),
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 58, brakeTorqueNm: 46.2, veAtm: 0.88 } }),
    ];
    const s = summarizeSweep(pts);
    expect(s.nPoints).toBe(3);
    expect(s.peakPower!.rpm).toBe(10000);
    expect(s.peakTorque!.rpm).toBe(10000);
    expect(s.peakVe!.rpm).toBe(10000);
    expect(s.powerband).not.toBeNull();
  });

  it("reports maxKnockIntegral null when no point carries knock", () => {
    const pts = [
      makeSweepPoint({ rpm: 8000 }),
      makeSweepPoint({ rpm: 10000 }),
    ];
    expect(summarizeSweep(pts).maxKnockIntegral).toBeNull();
  });

  it("reports the max knockIntegral when at least one point carries it", () => {
    const pts = [
      makeSweepPoint({ rpm: 8000, lastCycle: { knockIntegral: 0.21 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { knockIntegral: 0.41 } }),
      makeSweepPoint({ rpm: 12000 }),
    ];
    expect(summarizeSweep(pts).maxKnockIntegral).toBeCloseTo(0.41, 6);
  });

  it("sorts defensively before summarizing", () => {
    const pts = [
      makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 58 } }),
      makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50 } }),
      makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64 } }),
    ];
    expect(summarizeSweep(pts).peakPower!.rpm).toBe(10000);
  });
});
