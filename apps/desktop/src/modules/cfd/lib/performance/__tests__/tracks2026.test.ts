import { describe, it, expect } from "vitest";

import type { TorqueCurve } from "../index";
import {
  parseTrack,
  trackLength,
  simLap,
  SDM26_VEHICLE,
  AUTOCROSS_2026,
  ENDURANCE_2026,
} from "../index";

const flatCurve = (t: number): TorqueCurve => [
  { rpm: 0, torqueNm: t },
  { rpm: 20000, torqueNm: t },
];

describe("parseTrack", () => {
  it("maps null / non-positive radius to a straight (Infinity), floors length, keeps name/closed", () => {
    const t = parseTrack({
      name: "t",
      closed: true,
      segments: [
        { length: 10, radius: null }, // straight
        { length: 20, radius: 5 }, // corner
        { length: -3, radius: 0 }, // length floored to 0; radius 0 → straight
        { length: 5, radius: -2 }, // negative radius → straight
      ],
    });
    expect(t.name).toBe("t");
    expect(t.closed).toBe(true);
    expect(t.segments[0]!.radius).toBe(Infinity);
    expect(t.segments[1]!.radius).toBe(5);
    expect(t.segments[2]!.length).toBe(0);
    expect(t.segments[2]!.radius).toBe(Infinity);
    expect(t.segments[3]!.radius).toBe(Infinity);
    expect(trackLength(t)).toBeCloseTo(35, 6); // 10 + 20 + 0 + 5
  });
});

describe("2026 competition tracks", () => {
  it("Autocross 2026 — point-to-point, 39 segments, ~738 m", () => {
    expect(AUTOCROSS_2026.name).toBe("Autocross 2026");
    expect(AUTOCROSS_2026.closed).toBe(false);
    expect(AUTOCROSS_2026.segments).toHaveLength(39);
    expect(trackLength(AUTOCROSS_2026)).toBeCloseTo(738.3, 1);
    const straights = AUTOCROSS_2026.segments.filter((s) => s.radius === Infinity);
    const corners = AUTOCROSS_2026.segments.filter((s) => Number.isFinite(s.radius));
    expect(straights).toHaveLength(11);
    expect(corners).toHaveLength(28);
    // Every corner has a real positive radius; tightest matches the source.
    expect(corners.every((s) => s.radius > 0)).toBe(true);
    expect(Math.min(...corners.map((s) => s.radius))).toBeCloseTo(5.4, 6);
  });

  it("Endurance 2026 — closed loop, 61 segments, ~2.30 km", () => {
    expect(ENDURANCE_2026.name).toBe("Endurance 2026");
    expect(ENDURANCE_2026.closed).toBe(true);
    expect(ENDURANCE_2026.segments).toHaveLength(61);
    expect(trackLength(ENDURANCE_2026)).toBeCloseTo(2299.8, 1);
    const corners = ENDURANCE_2026.segments.filter((s) => Number.isFinite(s.radius));
    expect(corners).toHaveLength(46);
    expect(Math.min(...corners.map((s) => s.radius))).toBeCloseTo(4.5, 6);
  });

  it("the lap sim runs on both real courses; the longer endurance lap is slower", () => {
    const ax = simLap(flatCurve(50), SDM26_VEHICLE, AUTOCROSS_2026);
    const en = simLap(flatCurve(50), SDM26_VEHICLE, ENDURANCE_2026);
    for (const r of [ax, en]) {
      expect(Number.isFinite(r.lapTimeS)).toBe(true);
      expect(r.lapTimeS).toBeGreaterThan(0);
      expect(r.fuelKg).toBeGreaterThan(0);
      expect(r.vMaxMps).toBeGreaterThan(r.vMinMps);
    }
    // Endurance lap (~2.30 km) is ~3× the autocross run (~0.74 km).
    expect(en.lapTimeS).toBeGreaterThan(ax.lapTimeS);
  });
});
