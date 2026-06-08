import { describe, it, expect } from "vitest";

import type { VehicleConfig } from "../types";
import type { TorqueCurve } from "../torqueCurve";
import { simLap } from "../lapSim";
import {
  synthesizeAutocross,
  synthesizeEndurance,
  trackLength,
  type Track,
} from "../track";

const G = 9.80665;

const flatCurve = (t: number): TorqueCurve => [
  { rpm: 0, torqueNm: t },
  { rpm: 20000, torqueNm: t },
];

function makeVehicle(over: Partial<VehicleConfig> = {}): VehicleConfig {
  return {
    name: "test",
    massKg: 250,
    weightDistFront: 0.5,
    cgHeightM: 0.3,
    wheelbaseM: 1.5,
    trackWidthM: 1.2,
    tireRadiusM: 0.2,
    muLong: 1.5,
    muLat: 1.5,
    cdaM2: 0,
    claM2: 0,
    airDensityKgM3: 1.162,
    crr: 0,
    drivetrainEff: 1,
    gearRatios: [2.0],
    primaryReduction: 1,
    finalDrive: 1,
    shiftRpm: 9000,
    revLimitRpm: 1e9,
    shiftTimeS: 0,
    ...over,
  };
}

describe("track synthesis", () => {
  it("autocross is ~800 m open; endurance is ~1000 m closed", () => {
    const ax = synthesizeAutocross();
    expect(ax.closed).toBe(false);
    expect(trackLength(ax)).toBeCloseTo(800, 0);

    const en = synthesizeEndurance();
    expect(en.closed).toBe(true);
    expect(trackLength(en)).toBeCloseTo(1000, 0);
  });
});

describe("simLap", () => {
  it("a constant-radius circle laps at the cornering-speed limit", () => {
    const R = 20;
    const track: Track = {
      name: "circle",
      segments: [{ length: 2 * Math.PI * R, radius: R }],
      closed: true,
    };
    const v = makeVehicle({ muLat: 1.5, claM2: 0, cdaM2: 0, crr: 0 });
    const res = simLap(flatCurve(120), v, track, { ds: 1 });
    const vCorner = Math.sqrt(1.5 * G * R); // no aero → exact
    const expected = (2 * Math.PI * R) / vCorner;
    expect(res.lapTimeS).toBeGreaterThan(expected * 0.97);
    expect(res.lapTimeS).toBeLessThan(expected * 1.05);
    expect(res.vMaxMps).toBeCloseTo(vCorner, 0);
  });

  it("a tighter circle is slower (lower avg speed) than an open one", () => {
    const v = makeVehicle({ claM2: 0 });
    const tight: Track = { name: "t", segments: [{ length: 2 * Math.PI * 8, radius: 8 }], closed: true };
    const open: Track = { name: "o", segments: [{ length: 2 * Math.PI * 30, radius: 30 }], closed: true };
    expect(simLap(flatCurve(120), v, tight, { ds: 1 }).avgSpeedMps).toBeLessThan(
      simLap(flatCurve(120), v, open, { ds: 1 }).avgSpeedMps,
    );
  });

  it("a straight gives a finite accel-limited time and burns fuel", () => {
    const track: Track = { name: "straight", segments: [{ length: 200, radius: Infinity }], closed: false };
    const res = simLap(flatCurve(80), makeVehicle(), track);
    expect(res.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(res.lapTimeS)).toBe(true);
    expect(res.fuelKg).toBeGreaterThan(0);
    expect(res.co2Kg).toBeGreaterThan(0);
  });

  it("E85 CO₂ factor yields less CO₂ than gasoline for the same work", () => {
    const track: Track = { name: "straight", segments: [{ length: 200, radius: Infinity }], closed: false };
    const v = makeVehicle();
    const gas = simLap(flatCurve(80), v, track, { co2PerL: 2.31 });
    const e85 = simLap(flatCurve(80), v, track, { co2PerL: 1.65 });
    expect(e85.co2Kg).toBeLessThan(gas.co2Kg);
  });

  it("runs on the synthesized autocross + endurance tracks", () => {
    const v = makeVehicle({
      gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
      primaryReduction: 2.111,
      finalDrive: 3.0,
      tireRadiusM: 0.2,
      revLimitRpm: 14500,
      cdaM2: 1.24,
      claM2: 3.09,
      crr: 0.02,
    });
    const ax = simLap(flatCurve(50), v, synthesizeAutocross());
    const en = simLap(flatCurve(50), v, synthesizeEndurance());
    expect(ax.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(ax.lapTimeS)).toBe(true);
    expect(en.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(en.lapTimeS)).toBe(true);
  });
});
