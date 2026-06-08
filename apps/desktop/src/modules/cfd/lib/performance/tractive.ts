// Tractive effort: convert the engine torque curve + gearing into wheel force vs
// vehicle speed, plus the traction-limit and resistance lines that bound it.
//
// Key identity (no tire radius needed — it's baked into the gearing table):
//   F_wheel = T_engine · η · ω_engine / v ,  ω_engine = 2π·rpm/60 ,  rpm = v / vps
//   ⇒ F_i(v) = T(rpm) · η · (2π/60) / vps_i

import type { VehicleConfig } from "./types";
import { gearVps, topSpeedMps } from "./vehicle";
import { torqueAtRpm, type TorqueCurve } from "./torqueCurve";

export const G = 9.80665;
const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;

/** Wheel tractive force (N) available in `gearIdx` at speed `v` (m/s). Returns 0
 *  when this gear would spin the engine past the rev limit at that speed. */
export function tractiveForceInGear(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  gearIdx: number,
  v: number,
): number {
  const vps = gearVps(vehicle, gearIdx);
  if (vps <= 0) return 0;
  const rpm = v / vps;
  if (rpm > vehicle.revLimitRpm) return 0;
  const torque = torqueAtRpm(curve, rpm);
  return (torque * vehicle.drivetrainEff * RAD_PER_S_PER_RPM) / vps;
}

/** Best tractive force across all gears at `v` (the usable envelope) and which
 *  gear delivers it. */
export function tractiveEnvelope(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  v: number,
): { force: number; gearIdx: number } {
  let best = { force: 0, gearIdx: 0 };
  for (let i = 0; i < vehicle.gearRatios.length; i++) {
    const f = tractiveForceInGear(curve, vehicle, i, v);
    if (f > best.force) best = { force: f, gearIdx: i };
  }
  return best;
}

/** Fraction of total aero downforce carried by the rear (driven) axle. SDM26
 *  aero balance is ~53% front, so ~0.47 rear. */
const REAR_AERO_FRAC = 0.47;

/** Rear-axle traction limit (N) at speed `v`, RWD. Includes longitudinal weight
 *  transfer under acceleration (closed form: F = μ(W_rear + F·h/L) solved for F)
 *  and rear aero downforce — both raise grip well above the static μ·m·g·rear
 *  estimate, which is why a real FSAE car launches far harder. */
export function tractionLimit(vehicle: VehicleConfig, v = 0): number {
  const rearStatic = vehicle.massKg * G * (1 - vehicle.weightDistFront);
  const rearAero = 0.5 * vehicle.airDensityKgM3 * vehicle.claM2 * v * v * REAR_AERO_FRAC;
  const denom = Math.max(1 - (vehicle.muLong * vehicle.cgHeightM) / vehicle.wheelbaseM, 0.05);
  return (vehicle.muLong * (rearStatic + rearAero)) / denom;
}

/** Aero drag + rolling resistance (N) at speed `v`. */
export function resistanceForce(vehicle: VehicleConfig, v: number): number {
  const drag = 0.5 * vehicle.airDensityKgM3 * vehicle.cdaM2 * v * v;
  const roll = vehicle.crr * vehicle.massKg * G;
  return drag + roll;
}

export interface TractiveMap {
  speedsMps: number[];
  /** [gearIdx][speedIdx]; NaN where the gear is past the rev limit (line breaks). */
  perGearForce: number[][];
  envelopeForce: number[];
  resistance: number[];
  /** Traction-limit force per speed (rises with aero downforce). */
  tractionLimit: number[];
}

/** Sample the tractive map over a speed grid for charting. */
export function tractiveMap(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  steps = 80,
): TractiveMap {
  const vMax = Math.max(topSpeedMps(vehicle), 1);
  const speedsMps: number[] = [];
  for (let j = 0; j <= steps; j++) speedsMps.push((vMax * j) / steps);

  const perGearForce = vehicle.gearRatios.map((_, i) =>
    speedsMps.map((v) => {
      const f = tractiveForceInGear(curve, vehicle, i, v);
      return f > 0 ? f : Number.NaN; // NaN breaks the line past the rev limit
    }),
  );
  const envelopeForce = speedsMps.map(
    (v) => tractiveEnvelope(curve, vehicle, v).force,
  );
  const resistance = speedsMps.map((v) => resistanceForce(vehicle, v));

  return {
    speedsMps,
    perGearForce,
    envelopeForce,
    resistance,
    tractionLimit: speedsMps.map((v) => tractionLimit(vehicle, v)),
  };
}
