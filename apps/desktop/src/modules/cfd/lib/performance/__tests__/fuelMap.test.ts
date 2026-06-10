// Variable-throttle (Willans) fuel model from solver sweep data. Synthetic
// sweep points — no proprietary data.

import { describe, it, expect } from "vitest";
import { fuelMapFromSweep, fuelFlowKgS } from "../fuelMap";
import { makeCycleStats } from "../../../__tests__/fakes/study";
import type { SweepPoint } from "../../../state/types";

function pt(rpm: number, brakeKw: number, indKw: number, intakeG: number): SweepPoint {
  return {
    rpm,
    convergedCycle: 10,
    nCyclesRun: 12,
    nonconservationMax: 1e-7,
    wallTimeS: 1,
    stepCount: 100,
    lastCycle: makeCycleStats({
      brakePowerKW: brakeKw,
      indicatedPowerKW: indKw,
      intakeMassPerCycleG: intakeG,
    }),
  } as SweepPoint;
}

const POINTS = [
  pt(6000, 25, 28, 0.55),
  pt(9000, 40, 45, 0.62),
  pt(12000, 45, 52, 0.58),
];

describe("fuelMapFromSweep / fuelFlowKgS", () => {
  const map = fuelMapFromSweep(POINTS)!;

  it("derives friction power and indicated efficiency from the sweep", () => {
    expect(map).not.toBeNull();
    expect(map.rpms).toEqual([6000, 9000, 12000]);
    expect(map.pFricKw[0]).toBeCloseTo(3, 6); // 28 − 25
    // η_ind @6000: fuel = 0.55 g/cycle / 13.1 AFR × 50 cyc/s = 2.0992e-3 kg/s
    // η = 28 kW / (2.0992e-3 × 44 MJ) ≈ 0.303
    expect(map.etaInd[0]).toBeCloseTo(0.303, 2);
  });

  it("Willans: zero demand still pays the friction floor; flow rises with demand", () => {
    const lhv = 43e6;
    const idle = fuelFlowKgS(map, 9000, 0, lhv);
    const half = fuelFlowKgS(map, 9000, 20, lhv);
    const wot = fuelFlowKgS(map, 9000, 40, lhv);
    expect(idle).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(idle);
    expect(wot).toBeGreaterThan(half);
    // demand above WOT clamps to WOT
    expect(fuelFlowKgS(map, 9000, 400, lhv)).toBeCloseTo(wot, 12);
  });

  it("returns null when the sweep lacks the channels (dyno/synthetic curves)", () => {
    const bare = POINTS.map((p) => ({
      ...p,
      lastCycle: { ...p.lastCycle, intakeMassPerCycleG: 0 },
    }));
    expect(fuelMapFromSweep(bare as SweepPoint[])).toBeNull();
  });
});
