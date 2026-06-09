// Pins the SDM26 lap-sim calibration to the real 2026 data. Feeds the
// uncalibrated SDM26 torque curve (engine-sim parity fixture) through the SAME
// production path the app uses (computeEvents + SDM26_VEHICLE + REFERENCE_2026)
// and checks the model lands near the measured results. Tolerances are loose by
// design — conditions, driver, and tire temps move the real numbers, so this
// guards "still calibrated", not an exact match.

import { describe, it, expect } from "vitest";

import type { TorqueCurve } from "../index";
import {
  simAccel,
  computeEvents,
  SDM26_VEHICLE,
  REFERENCE_2026,
  FUELS,
} from "../index";

// Uncalibrated SDM26 brake torque vs rpm — sweep_python_v1/sdm26_characteristic_4k_to_15k.csv.
const SDM26_CURVE: TorqueCurve = [
  { rpm: 4000, torqueNm: 60.997 }, { rpm: 4500, torqueNm: 61.335 },
  { rpm: 5000, torqueNm: 59.423 }, { rpm: 5500, torqueNm: 55.846 },
  { rpm: 6000, torqueNm: 54.969 }, { rpm: 6500, torqueNm: 49.508 },
  { rpm: 7000, torqueNm: 58.086 }, { rpm: 7500, torqueNm: 55.997 },
  { rpm: 8000, torqueNm: 62.640 }, { rpm: 8500, torqueNm: 56.256 },
  { rpm: 9000, torqueNm: 54.200 }, { rpm: 9500, torqueNm: 48.313 },
  { rpm: 10000, torqueNm: 46.191 }, { rpm: 10500, torqueNm: 44.040 },
  { rpm: 11000, torqueNm: 48.829 }, { rpm: 11500, torqueNm: 48.216 },
  { rpm: 12000, torqueNm: 43.253 }, { rpm: 12500, torqueNm: 36.623 },
  { rpm: 13000, torqueNm: 30.067 }, { rpm: 13500, torqueNm: 23.636 },
  { rpm: 14000, torqueNm: 19.011 }, { rpm: 14500, torqueNm: 21.985 },
  { rpm: 15000, torqueNm: 23.784 },
];

describe("SDM26 calibration to real 2026 results", () => {
  const gas = computeEvents(SDM26_CURVE, SDM26_VEHICLE, REFERENCE_2026);
  // Mines anchor: same CBR600RR class on E85.
  const e85 = computeEvents(SDM26_CURVE, SDM26_VEHICLE, REFERENCE_2026, { fuel: FUELS.e85 });

  it("accel ≈ 4.2 s (real)", () => {
    const accel = simAccel(SDM26_CURVE, SDM26_VEHICLE);
    expect(accel.timeS).toBeGreaterThan(3.9);
    expect(accel.timeS).toBeLessThan(4.6);
  });

  it("autocross ≈ 42.9 s flat-out → ~90 pts (real 42.922 s, 90.39 pts)", () => {
    expect(gas.autocross.lapTimeS).toBeGreaterThan(41);
    expect(gas.autocross.lapTimeS).toBeLessThan(45);
    expect(gas.autocross.points).toBeGreaterThan(84);
    expect(gas.autocross.points).toBeLessThan(96);
  });

  it("endurance ≈ 159.6 s/lap at managed race pace (Mines run-average)", () => {
    // Run-average (in/out laps included) — the SAME convention as the official
    // baselines (enduranceTMin 142.085 is corrected-total/laps), so the score
    // comparison is apples-to-apples. Scoring a clean-lap 148 s against the
    // run-average Tmin briefly put SDM26 in P1 (2026-06-09).
    expect(gas.endurance.lapTimeS).toBeGreaterThan(155);
    expect(gas.endurance.lapTimeS).toBeLessThan(165);
  });

  it("endurance points land mid-field, not field-beating (the P1 regression)", () => {
    // Mines officially scored ~186.6 endurance pts at this pace; SDM26 (similar
    // car, slower team) must not come out ahead of the 2026 field.
    expect(gas.endurance.points!).toBeGreaterThan(160);
    expect(gas.endurance.points!).toBeLessThan(210);
    expect(gas.totalPoints!).toBeLessThan(340); // was 382.7 when miscalibrated
  });

  it("E85 endurance reproduces the Mines fuel anchor (0.9786 kg CO₂/lap)", () => {
    expect(e85.endurance.co2KgPerLap).toBeCloseTo(0.9786, 1); // within 0.05
    // Run-average pace convention → FEF/points reproduce Mines' OFFICIAL
    // results (FEF 0.536, 43 pts) rather than running above them.
    expect(e85.efficiency.factor!).toBeCloseTo(0.536, 1); // within 0.05
    expect(e85.efficiency.points!).toBeGreaterThan(38);
    expect(e85.efficiency.points!).toBeLessThan(50);
  });

  it("E85 burns more volume but emits less CO₂/lap than gasoline", () => {
    expect(e85.endurance.co2KgPerLap).toBeLessThan(gas.endurance.co2KgPerLap);
  });

  it("total points is scorable from the available events (no field accel Tmin)", () => {
    // REFERENCE_2026 has no accelTMin, so accel isn't scored — but total points
    // still ranks on autocross + endurance + efficiency (the optimizer's
    // "rank by total pts" must not go null just because one baseline is absent).
    expect(gas.accel.points).toBeNull();
    expect(gas.totalPoints).not.toBeNull();
    const sum = (gas.autocross.points ?? 0) + (gas.endurance.points ?? 0) + (gas.efficiency.points ?? 0);
    expect(gas.totalPoints!).toBeCloseTo(sum, 6);
    expect(gas.totalPoints!).toBeGreaterThan(0);
  });
});
