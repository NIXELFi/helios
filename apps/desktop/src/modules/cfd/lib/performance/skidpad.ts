// Skidpad (§D.10) gear/RPM readout — NOT a sim. The car holds a constant-radius
// turn, so a target lap time fixes the speed, which fixes the engine RPM in each
// gear. Tells you which gear sits in the meat of the powerband on the pad.
//
// Skidpad geometry: inner circle 15.25 m dia (r = 7.625 m); the car's path hugs
// just outside the inner cones, so its radius is offset out by ~half the track
// width plus a little clearance.

import type { VehicleConfig } from "./types";
import { gearVps } from "./vehicle";
import { G } from "./tractive";

export const SKIDPAD_INNER_RADIUS_M = 7.625; // 15.25 m dia / 2

export interface SkidpadGear {
  gear: number; // 1-based
  rpm: number;
}

export interface SkidpadResult {
  radiusM: number;
  speedMps: number;
  speedKph: number;
  lateralG: number;
  perGear: SkidpadGear[];
}

export interface SkidpadOpts {
  /** Override the driven-path radius directly (m). */
  radiusM?: number;
  /** Clearance between the inner tire and the inner cones (m). Default 0.1. */
  clearanceM?: number;
}

export function skidpad(
  vehicle: VehicleConfig,
  targetTimeS: number,
  opts: SkidpadOpts = {},
): SkidpadResult {
  const radiusM =
    opts.radiusM ??
    SKIDPAD_INNER_RADIUS_M + vehicle.trackWidthM / 2 + (opts.clearanceM ?? 0.1);
  const speedMps = targetTimeS > 0 ? (2 * Math.PI * radiusM) / targetTimeS : 0;
  const lateralG = radiusM > 0 ? (speedMps * speedMps) / (radiusM * G) : 0;
  const perGear: SkidpadGear[] = vehicle.gearRatios.map((_, i) => {
    const vps = gearVps(vehicle, i);
    return { gear: i + 1, rpm: vps > 0 ? speedMps / vps : 0 };
  });
  return {
    radiusM,
    speedMps,
    speedKph: speedMps * 3.6,
    lateralG,
    perGear,
  };
}
