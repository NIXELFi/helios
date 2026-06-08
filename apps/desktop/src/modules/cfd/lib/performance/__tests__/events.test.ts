import { describe, it, expect } from "vitest";

import type { VehicleConfig, ReferenceBaseline } from "../types";
import type { TorqueCurve } from "../torqueCurve";
import {
  autocrossPoints,
  enduranceTimePoints,
  efficiencyFactor,
  efficiencyPoints,
  computeEvents,
} from "../index";

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
    cdaM2: 1.0,
    claM2: 2.0,
    airDensityKgM3: 1.162,
    crr: 0.02,
    drivetrainEff: 0.85,
    gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
    primaryReduction: 2.111,
    finalDrive: 3.0,
    shiftRpm: 9500,
    revLimitRpm: 14500,
    shiftTimeS: 0.1,
    ...over,
  };
}

const EMPTY: ReferenceBaseline = {
  accelTMin: null,
  autocrossTMin: null,
  enduranceTMin: null,
  co2MinPerLap: null,
  co2MaxPerLap: null,
};

describe("event point formulas", () => {
  it("autocross: 125 at Tmin, 6.5 floor at/over Tmax = 1.45·Tmin", () => {
    expect(autocrossPoints(40, 40)).toBeCloseTo(125, 6);
    expect(autocrossPoints(58, 40)).toBeCloseTo(6.5, 6); // exactly Tmax
    expect(autocrossPoints(80, 40)).toBe(6.5);
  });
  it("endurance time: 250 at Tmin, 0 at/over Tmax", () => {
    expect(enduranceTimePoints(90, 90)).toBeCloseTo(250, 6);
    expect(enduranceTimePoints(90 * 1.45, 90)).toBe(0);
  });
  it("efficiency factor = (Tmin/Ty)·(CO2min/CO2you)", () => {
    expect(efficiencyFactor(100, 2, 90, 1.5)).toBeCloseTo((90 / 100) * (1.5 / 2), 6);
  });
  it("efficiency points clamp 0–100 between EFmin and EFmax", () => {
    expect(efficiencyPoints(1.0, 0.5, 1.0)).toBeCloseTo(100, 6);
    expect(efficiencyPoints(0.5, 0.5, 1.0)).toBeCloseTo(0, 6);
    expect(efficiencyPoints(0.75, 0.5, 1.0)).toBeCloseTo(50, 6);
    expect(efficiencyPoints(2.0, 0.5, 1.0)).toBe(100); // clamped
  });
});

describe("computeEvents", () => {
  it("returns finite physical metrics and null points with no baseline", () => {
    const e = computeEvents(flatCurve(50), makeVehicle(), EMPTY);
    expect(e.accel.timeS).toBeGreaterThan(0);
    expect(e.autocross.lapTimeS).toBeGreaterThan(0);
    expect(e.endurance.lapTimeS).toBeGreaterThan(0);
    expect(e.endurance.co2KgPerLap).toBeGreaterThan(0);
    expect(e.accel.points).toBeNull();
    expect(e.autocross.points).toBeNull();
    expect(e.endurance.points).toBeNull();
    expect(e.efficiency.points).toBeNull();
    expect(e.totalPoints).toBeNull();
  });

  it("projects all event points + a total when the full baseline is given", () => {
    const e0 = computeEvents(flatCurve(50), makeVehicle(), EMPTY);
    const baseline: ReferenceBaseline = {
      accelTMin: e0.accel.timeS * 0.95, // field slightly faster than us
      autocrossTMin: e0.autocross.lapTimeS * 0.95,
      enduranceTMin: e0.endurance.lapTimeS * 0.95,
      co2MinPerLap: e0.endurance.co2KgPerLap * 0.9,
      co2MaxPerLap: e0.endurance.co2KgPerLap * 1.5,
    };
    const e = computeEvents(flatCurve(50), makeVehicle(), baseline);
    expect(e.accel.points).not.toBeNull();
    expect(e.autocross.points).not.toBeNull();
    expect(e.endurance.points).not.toBeNull();
    expect(e.efficiency.factor).not.toBeNull();
    expect(e.efficiency.points).not.toBeNull();
    expect(e.totalPoints).not.toBeNull();
    expect(Number.isFinite(e.totalPoints as number)).toBe(true);
  });

  it("E85 CO₂ factor lowers endurance CO₂/lap vs gasoline", () => {
    const v = makeVehicle();
    const gas = computeEvents(flatCurve(50), v, EMPTY, { co2PerL: 2.31 });
    const e85 = computeEvents(flatCurve(50), v, EMPTY, { co2PerL: 1.65 });
    expect(e85.endurance.co2KgPerLap).toBeLessThan(gas.endurance.co2KgPerLap);
  });
});
