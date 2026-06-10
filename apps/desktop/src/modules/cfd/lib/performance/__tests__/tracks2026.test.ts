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

describe("2026 competition tracks (traced curvature, rules-nominal lengths)", () => {
  it("Autocross 2026 — point-to-point, exactly the rules-nominal 800 m", () => {
    expect(AUTOCROSS_2026.name).toContain("Autocross 2026");
    expect(AUTOCROSS_2026.closed).toBe(false);
    expect(trackLength(AUTOCROSS_2026)).toBeCloseTo(800, 1);
    // Continuously varying radius profile (one segment per trace interval) —
    // this is what killed the constant-radius "RPM hang" plateaus.
    expect(AUTOCROSS_2026.segments.length).toBeGreaterThan(200);
    const corners = AUTOCROSS_2026.segments.filter((s) => Number.isFinite(s.radius));
    expect(corners.length).toBeGreaterThan(50);
    expect(corners.every((s) => s.radius >= 4.5)).toBe(true); // rules hairpin floor (scaled ≥)
  });

  it("Endurance 2026 — closed loop, exactly the rules-nominal 2.20 km", () => {
    expect(ENDURANCE_2026.name).toContain("Endurance 2026");
    expect(ENDURANCE_2026.closed).toBe(true);
    expect(trackLength(ENDURANCE_2026)).toBeCloseTo(2200, 1);
    const corners = ENDURANCE_2026.segments.filter((s) => Number.isFinite(s.radius));
    expect(corners.length).toBeGreaterThan(100);
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
    // Endurance lap (2.2 km) is ~3× the autocross run (0.8 km).
    expect(en.lapTimeS).toBeGreaterThan(ax.lapTimeS);
  });
});
