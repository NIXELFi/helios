// Minimal input DTOs the lap-sim physics consumes, copied here so this package
// stays self-contained (the originals live in the CFD module's state/types.ts and
// lib/import/importDyno.ts, which drag in CFD-app coupling we must not import).
// These mirror the shapes the CFD app produces from the Rust engine sweep; the CFD
// module and the standalone Lap Sim plugin both feed lapsim-core values of these
// shapes. Keep field names in sync with cfd-core's serde DTOs.

/** One converged engine cycle's scalar outputs (subset the lap sim reads:
 *  brakeTorqueNm / indicatedPowerKW / intakeMassPerCycleG, etc.). */
export interface CycleStats {
  cycle: number;
  massTotal: number;
  massDrift: number;
  massInRestrictor: number;
  massOutCollector: number;
  netPortFlow: number;
  nonconservation: number;
  imepBar: number;
  bmepBar: number;
  fmepBar: number;
  veAtm: number;
  intakeMassPerCycleG: number;
  fResidual: number;
  indicatedPowerKW: number;
  indicatedPowerHp: number;
  brakePowerKW: number;
  brakePowerHp: number;
  wheelPowerKW: number;
  wheelPowerHp: number;
  indicatedTorqueNm: number;
  brakeTorqueNm: number;
  wheelTorqueNm: number;
  egtMean: number;
  knockIntegral?: number;
  knockRetardDeg?: number;
}

/** One RPM point of an engine sweep (the curve the lap sim turns into a torque
 *  curve + fuel map). */
export interface SweepPoint {
  rpm: number;
  convergedCycle: number;
  nCyclesRun: number;
  lastCycle: CycleStats;
  nonconservationMax: number;
  wallTimeS: number;
  stepCount: number;
  cycles: CycleStats[];
  captureDir?: string;
}

/** One row of an imported dyno trace (the alternative torque-curve source). */
export interface DynoPoint {
  rpm: number;
  powerKw: number | null;
  torqueNm: number | null;
}
