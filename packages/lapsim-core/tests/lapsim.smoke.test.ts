import { describe, it, expect } from "vitest";
import {
  simLap,
  torqueCurveFromSweep,
  autocrossLapOpts,
  SDM26_VEHICLE,
  AUTOCROSS_2026,
  type CycleStats,
  type SweepPoint,
  type TorqueCurve,
} from "../src";

// A small synthetic CBR600RR-ish brake-torque curve (Nm vs rpm).
const CURVE: TorqueCurve = [
  { rpm: 4000, torqueNm: 38 },
  { rpm: 7000, torqueNm: 52 },
  { rpm: 9500, torqueNm: 58 },
  { rpm: 11500, torqueNm: 54 },
  { rpm: 13500, torqueNm: 44 },
];

function cycle(brakeTorqueNm: number): CycleStats {
  return {
    cycle: 1, massTotal: 0, massDrift: 0, massInRestrictor: 0, massOutCollector: 0,
    netPortFlow: 0, nonconservation: 0, imepBar: 0, bmepBar: 0, fmepBar: 0, veAtm: 0,
    intakeMassPerCycleG: 0.3, fResidual: 0, indicatedPowerKW: 0, indicatedPowerHp: 0,
    brakePowerKW: 0, brakePowerHp: 0, wheelPowerKW: 0, wheelPowerHp: 0,
    indicatedTorqueNm: 0, brakeTorqueNm, wheelTorqueNm: 0, egtMean: 0,
  };
}

function sweepPoint(rpm: number, torqueNm: number): SweepPoint {
  return {
    rpm, convergedCycle: 1, nCyclesRun: 1, nonconservationMax: 0,
    wallTimeS: 0, stepCount: 0, cycles: [], lastCycle: cycle(torqueNm),
  };
}

describe("lapsim-core smoke", () => {
  it("simLap runs end-to-end on a preset car + 2026 autocross track", () => {
    const result = simLap(CURVE, SDM26_VEHICLE, AUTOCROSS_2026, {
      ...autocrossLapOpts(),
      channels: true,
    });
    expect(Number.isFinite(result.lapTimeS)).toBe(true);
    expect(result.lapTimeS).toBeGreaterThan(0);
    expect(result.lapTimeS).toBeLessThan(1000); // sanity: not NaN-inflated
    expect(result.vMaxMps).toBeGreaterThan(0);
    expect(result.channels).toBeDefined();
    expect(result.channels!.vMps.length).toBeGreaterThan(0);
  });

  it("torqueCurveFromSweep maps engine-sweep points (exercises the inputs.ts severance)", () => {
    const curve = torqueCurveFromSweep([
      sweepPoint(9500, 58),
      sweepPoint(4000, 38),
      sweepPoint(7000, 52),
    ]);
    expect(curve).toHaveLength(3);
    // sorted ascending by rpm
    expect(curve.map((p) => p.rpm)).toEqual([4000, 7000, 9500]);
    expect(curve[0]!.torqueNm).toBe(38);
  });
});
