import { describe, it, expect } from "vitest";

import type { SweepPoint } from "../../../state/types";
import type { VehicleConfig } from "../types";
import {
  torqueCurveFromSweep,
  torqueAtRpm,
  type TorqueCurve,
  totalReduction,
  gearVps,
  topSpeedMps,
  tractiveForceInGear,
  tractiveEnvelope,
  tractionLimit,
  resistanceForce,
  G,
  simAccel,
  skidpad,
  accelPoints,
} from "../index";

const TWO_PI_60 = (2 * Math.PI) / 60;

/** Minimal sweep point carrying just the brake torque the curve reads. */
function fakeSweepPoint(rpm: number, torqueNm: number): SweepPoint {
  return {
    rpm,
    convergedCycle: 1,
    nCyclesRun: 1,
    lastCycle: { brakeTorqueNm: torqueNm } as never,
    nonconservationMax: 0,
    wallTimeS: 0,
    stepCount: 0,
    cycles: [],
  } as unknown as SweepPoint;
}

/** Flat torque curve (constant torque across all rpm). */
function flatCurve(torqueNm: number): TorqueCurve {
  return [
    { rpm: 0, torqueNm },
    { rpm: 1e9, torqueNm },
  ];
}

function makeVehicle(over: Partial<VehicleConfig> = {}): VehicleConfig {
  return {
    name: "test",
    massKg: 200,
    weightDistFront: 0.5,
    cgHeightM: 0.3,
    wheelbaseM: 1.5,
    trackWidthM: 1.2,
    tireRadiusM: 0.2,
    muLong: 1.5,
    muLat: 1.5,
    cdaM2: 0,
    claM2: 0,
    airDensityKgM3: 1,
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

describe("torqueAtRpm", () => {
  const curve: TorqueCurve = [
    { rpm: 2000, torqueNm: 30 },
    { rpm: 4000, torqueNm: 50 },
    { rpm: 6000, torqueNm: 40 },
  ];
  it("interpolates linearly between points", () => {
    expect(torqueAtRpm(curve, 3000)).toBeCloseTo(40, 6); // halfway 30→50
    expect(torqueAtRpm(curve, 5000)).toBeCloseTo(45, 6); // halfway 50→40
  });
  it("clamps below the first and above the last rpm", () => {
    expect(torqueAtRpm(curve, 0)).toBe(30);
    expect(torqueAtRpm(curve, 99999)).toBe(40);
  });
  it("returns 0 for an empty curve", () => {
    expect(torqueAtRpm([], 5000)).toBe(0);
  });
});

describe("torqueCurveFromSweep", () => {
  it("extracts brake torque and sorts by rpm, dropping non-finite", () => {
    const pts = [
      fakeSweepPoint(6000, 40),
      fakeSweepPoint(2000, 30),
      fakeSweepPoint(Number.NaN, 99),
      fakeSweepPoint(4000, 50),
    ];
    const curve = torqueCurveFromSweep(pts);
    expect(curve.map((p) => p.rpm)).toEqual([2000, 4000, 6000]);
    expect(curve.map((p) => p.torqueNm)).toEqual([30, 50, 40]);
  });
});

describe("gearing", () => {
  it("totalReduction = primary × gear × finalDrive", () => {
    const v = makeVehicle({ gearRatios: [2.5], primaryReduction: 2.111, finalDrive: 3 });
    expect(totalReduction(v, 0)).toBeCloseTo(2.111 * 2.5 * 3, 9);
  });
  it("gearVps = 2π·r / (60·totalReduction)", () => {
    const v = makeVehicle({ gearRatios: [2], primaryReduction: 2, finalDrive: 3, tireRadiusM: 0.2 });
    const expected = (2 * Math.PI * 0.2) / (60 * (2 * 2 * 3));
    expect(gearVps(v, 0)).toBeCloseTo(expected, 9);
  });
  it("topSpeedMps = fastest (lowest-reduction) gear at the rev limit", () => {
    const v = makeVehicle({
      gearRatios: [3, 1.5], // 2nd is taller → faster
      primaryReduction: 1,
      finalDrive: 1,
      tireRadiusM: 0.2,
      revLimitRpm: 11000,
    });
    expect(topSpeedMps(v)).toBeCloseTo(gearVps(v, 1) * 11000, 6);
  });
});

describe("tractiveForceInGear", () => {
  it("matches the closed form T·η·(2π/60)/vps", () => {
    const v = makeVehicle({ drivetrainEff: 0.9, gearRatios: [2], primaryReduction: 2, finalDrive: 3, tireRadiusM: 0.2, revLimitRpm: 12000 });
    const curve = flatCurve(40);
    const vps = gearVps(v, 0);
    const expected = (40 * 0.9 * TWO_PI_60) / vps; // at speed 10, rpm = 10/vps ≈ 5700 < limit
    expect(tractiveForceInGear(curve, v, 0, 10)).toBeCloseTo(expected, 3);
  });
  it("returns 0 past the rev limit", () => {
    const v = makeVehicle({ gearRatios: [2], primaryReduction: 2, finalDrive: 3, tireRadiusM: 0.2, revLimitRpm: 1000 });
    const fast = 1001 * gearVps(v, 0); // rpm just over the limit
    expect(tractiveForceInGear(flatCurve(40), v, 0, fast)).toBe(0);
  });
});

describe("tractiveEnvelope", () => {
  it("picks the gear giving the most force at a given speed", () => {
    const v = makeVehicle({ gearRatios: [3, 1.5], primaryReduction: 1, finalDrive: 1, tireRadiusM: 0.2 });
    const curve = flatCurve(40);
    const env = tractiveEnvelope(curve, v, 5);
    const g0 = tractiveForceInGear(curve, v, 0, 5);
    const g1 = tractiveForceInGear(curve, v, 1, 5);
    expect(env.force).toBeCloseTo(Math.max(g0, g1), 6);
  });
});

describe("traction limit + resistance", () => {
  it("traction limit includes longitudinal weight transfer (closed form)", () => {
    const v = makeVehicle({ muLong: 1.4, massKg: 250, weightDistFront: 0.45, cgHeightM: 0.3, wheelbaseM: 1.5, claM2: 0 });
    const rearStatic = 250 * G * 0.55;
    const denom = 1 - (1.4 * 0.3) / 1.5;
    expect(tractionLimit(v, 0)).toBeCloseTo((1.4 * rearStatic) / denom, 6);
    expect(tractionLimit(v, 0)).toBeGreaterThan(1.4 * rearStatic); // beats static
  });
  it("resistance = ½ρ·CdA·v² + Crr·m·g", () => {
    const v = makeVehicle({ cdaM2: 1.2, airDensityKgM3: 1.18, crr: 0.02, massKg: 250 });
    const expected = 0.5 * 1.18 * 1.2 * 400 + 0.02 * 250 * G;
    expect(resistanceForce(v, 20)).toBeCloseTo(expected, 6);
  });
});

describe("simAccel", () => {
  it("matches the closed-form constant-force solution", () => {
    // Flat torque + single gear → constant force; no drag/roll; μ huge so not
    // traction-limited; no rev cutoff. Then x = ½at² is exact.
    const v = makeVehicle({
      massKg: 200,
      drivetrainEff: 1,
      gearRatios: [2],
      primaryReduction: 1,
      finalDrive: 1,
      tireRadiusM: 0.2,
      revLimitRpm: 1e9,
      muLong: 100,
    });
    const curve = flatCurve(50);
    const a = tractiveForceInGear(curve, v, 0, 0) / 200; // constant
    const tAnalytic = Math.sqrt((2 * 75) / a);
    const res = simAccel(curve, v, { dt: 0.001 });
    expect(res.finished).toBe(true);
    expect(res.timeS).toBeCloseTo(tAnalytic, 1); // within ~0.05 s
  });
  it("produces a trace starting at rest with positive trap speed", () => {
    const res = simAccel(flatCurve(50), makeVehicle({ muLong: 100 }), { dt: 0.002 });
    expect(res.trace[0]!.v).toBe(0);
    expect(res.trace[0]!.x).toBe(0);
    expect(res.trapSpeedMps).toBeGreaterThan(0);
    expect(res.finishGear).toBe(1); // single gear, never shifts
    expect(res.shiftPoints).toHaveLength(0);
  });
  it("shift time costs time — the run is slower than with instant shifts", () => {
    const v = makeVehicle({
      gearRatios: [10, 5],
      primaryReduction: 1,
      finalDrive: 1,
      tireRadiusM: 0.2,
      revLimitRpm: 4000,
      muLong: 100,
    });
    const instant = simAccel(flatCurve(50), { ...v, shiftTimeS: 0 }, { dt: 0.002 });
    const slow = simAccel(flatCurve(50), { ...v, shiftTimeS: 0.2 }, { dt: 0.002 });
    expect(slow.timeS).toBeGreaterThan(instant.timeS);
  });
  it("records sequential upshifts (here forced at the rev limit)", () => {
    const v = makeVehicle({
      gearRatios: [10, 5], // short gears so 1st rev-limits early within 75 m
      primaryReduction: 1,
      finalDrive: 1,
      tireRadiusM: 0.2,
      revLimitRpm: 4000,
      muLong: 100,
    });
    const res = simAccel(flatCurve(50), v, { dt: 0.002 });
    expect(res.shiftPoints.length).toBeGreaterThanOrEqual(1);
    const s = res.shiftPoints[0]!;
    expect(s.fromGear).toBe(1);
    expect(s.toGear).toBe(2);
    expect(s.shiftRpm).toBeGreaterThan(3900); // ~ at the 4000 rev limit
    expect(res.finishGear).toBeGreaterThanOrEqual(2);
  });
  it("a larger shift time never increases the shift count (worth-it skips marginal shifts)", () => {
    const curve: TorqueCurve = [
      { rpm: 2000, torqueNm: 60 },
      { rpm: 14000, torqueNm: 20 }, // falling torque → real crossover shifts exist
    ];
    const v = makeVehicle({
      gearRatios: [1.6, 1.3, 1.1, 1.0],
      primaryReduction: 1,
      finalDrive: 1,
      tireRadiusM: 0.2,
      revLimitRpm: 14000,
      muLong: 100,
    });
    const instant = simAccel(curve, { ...v, shiftTimeS: 0 }, { dt: 0.002 });
    const slow = simAccel(curve, { ...v, shiftTimeS: 0.3 }, { dt: 0.002 });
    expect(slow.shiftPoints.length).toBeLessThanOrEqual(instant.shiftPoints.length);
  });
});

describe("skidpad", () => {
  it("derives speed, lateral g and per-gear rpm from a target time", () => {
    const v = makeVehicle({ trackWidthM: 1.2, gearRatios: [2.75, 2.0], primaryReduction: 2.111, finalDrive: 3 });
    const r = skidpad(v, 4.9); // R = 7.625 + 0.6 + 0.1 = 8.325
    expect(r.radiusM).toBeCloseTo(8.325, 6);
    expect(r.speedMps).toBeCloseTo((2 * Math.PI * 8.325) / 4.9, 4);
    expect(r.lateralG).toBeCloseTo((r.speedMps * r.speedMps) / (8.325 * G), 4);
    expect(r.perGear).toHaveLength(2);
    expect(r.perGear[0]!.rpm).toBeCloseTo(r.speedMps / gearVps(v, 0), 2);
  });
  it("honors an explicit radius override", () => {
    const r = skidpad(makeVehicle(), 5, { radiusM: 9 });
    expect(r.radiusM).toBe(9);
    expect(r.speedMps).toBeCloseTo((2 * Math.PI * 9) / 5, 6);
  });
});

describe("final drive scaling", () => {
  it("a taller final drive lowers speed-per-rpm and top speed proportionally", () => {
    const base = makeVehicle({ gearRatios: [2], primaryReduction: 1, finalDrive: 3, tireRadiusM: 0.2, revLimitRpm: 10000 });
    const taller = { ...base, finalDrive: 6 };
    expect(gearVps(taller, 0)).toBeCloseTo(gearVps(base, 0) / 2, 9);
    expect(topSpeedMps(taller)).toBeCloseTo(topSpeedMps(base) / 2, 6);
  });
  it("raises engine rpm at a fixed speed (skidpad) for a taller final drive", () => {
    const base = makeVehicle({ gearRatios: [2], primaryReduction: 1, finalDrive: 3, tireRadiusM: 0.2 });
    const taller = { ...base, finalDrive: 6 };
    const rBase = skidpad(base, 5, { radiusM: 9 });
    const rTall = skidpad(taller, 5, { radiusM: 9 });
    expect(rTall.perGear[0]!.rpm).toBeCloseTo(rBase.perGear[0]!.rpm * 2, 2);
  });
});

describe("accelPoints (§D.9)", () => {
  it("gives 100 when you match the fastest team", () => {
    expect(accelPoints(4.0, 4.0)).toBeCloseTo(100, 6);
  });
  it("gives the 4.5 floor at or beyond Tmax = 1.5·Tmin", () => {
    expect(accelPoints(6.0, 4.0)).toBeCloseTo(4.5, 6);
    expect(accelPoints(9.0, 4.0)).toBe(4.5);
  });
  it("lands between floor and 100 when faster than the field but not best", () => {
    const p = accelPoints(4.5, 4.0);
    expect(p).toBeGreaterThan(4.5);
    expect(p).toBeLessThan(100);
  });
  it("returns 0 for an invalid baseline", () => {
    expect(accelPoints(4.0, 0)).toBe(0);
  });
});
