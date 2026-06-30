// Torque-curve sources for the standalone Lap Sim plugin. In the CFD app a
// CurveSource is derived from completed sweeps / optimization studies (see the
// module's lib/curveSources.ts, which pulls CFD app state we must NOT import
// here). The plugin is sandboxed and has no such state, so we keep the SAME
// shape but supply a single built-in source synthesized from the default
// engine sweep — enough to drive the full screen out of the box. A future
// version can hydrate more sources from an imported dyno CSV.

import type { SweepPoint, CycleStats } from "@helios/lapsim-core";
import { DEFAULT_CURVE } from "./defaultSweep";

export interface CurveSource {
  id: string;
  label: string;
  configName: string;
  points: SweepPoint[];
}

/** A CycleStats with every scalar zeroed — the base the synthesizer overrides
 *  the few fields the lap sim / lap player actually read on top of. */
function zeroCycle(cycle: number): CycleStats {
  return {
    cycle,
    massTotal: 0,
    massDrift: 0,
    massInRestrictor: 0,
    massOutCollector: 0,
    netPortFlow: 0,
    nonconservation: 0,
    imepBar: 0,
    bmepBar: 0,
    fmepBar: 0,
    veAtm: 0,
    intakeMassPerCycleG: 0,
    fResidual: 0,
    indicatedPowerKW: 0,
    indicatedPowerHp: 0,
    brakePowerKW: 0,
    brakePowerHp: 0,
    wheelPowerKW: 0,
    wheelPowerHp: 0,
    indicatedTorqueNm: 0,
    brakeTorqueNm: 0,
    wheelTorqueNm: 0,
    egtMean: 0,
    knockIntegral: 0,
    knockRetardDeg: 0,
  };
}

/** Synthesize a SweepPoint[] from the default torque curve. The screen reads
 *  point.lastCycle fields (brakeTorqueNm, brakePowerKW, indicatedPowerKW,
 *  intakeMassPerCycleG, …) for the lap player gauges + the fuel map; the lap
 *  sim itself only needs brakeTorqueNm vs rpm. We fill the load-bearing fields
 *  and zero the rest. */
function sweepFromCurve(curve: typeof DEFAULT_CURVE): SweepPoint[] {
  return curve.map(({ rpm, torqueNm }, i) => {
    const brakePowerKW = (torqueNm * rpm * 2 * Math.PI) / 60 / 1000;
    const lastCycle: CycleStats = {
      ...zeroCycle(i),
      brakeTorqueNm: torqueNm,
      brakePowerKW,
      indicatedPowerKW: brakePowerKW / 0.85,
      intakeMassPerCycleG: 0.3,
    };
    return {
      rpm,
      convergedCycle: 0,
      nCyclesRun: 0,
      lastCycle,
      nonconservationMax: 0,
      wallTimeS: 0,
      stepCount: 0,
      cycles: [],
    };
  });
}

export const DEFAULT_SOURCES: CurveSource[] = [
  {
    id: "default",
    label: "Default sweep",
    configName: "SDM26",
    points: sweepFromCurve(DEFAULT_CURVE),
  },
];
