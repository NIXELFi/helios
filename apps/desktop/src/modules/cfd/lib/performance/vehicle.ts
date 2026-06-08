// Vehicle presets + gearing helpers. Gearing is the explicit drivetrain:
// engine → primary reduction → gearbox ratio → final drive (sprocket) → wheel,
// so a sprocket swap (finalDrive) or a tire change recomputes everything.

import type { ReferenceBaseline, VehicleConfig } from "./types";

/** SDM26 (ASU Car #106) — chassis/aero from the 2026 FSAE spec sheet; gearbox =
 *  stock Honda CBR600RR (PC40) ratios + 2.111 primary, with SDM's 3.0 final
 *  drive. μ, shift_rpm and rev_limit are estimates pending confirmation. */
export const SDM26_VEHICLE: VehicleConfig = {
  name: "SDM26",
  massKg: 268, // 200 kg car (no driver/fuel) + 68 kg driver
  weightDistFront: 0.485, // with 68 kg driver
  cgHeightM: 0.2845,
  wheelbaseM: 1.53,
  trackWidthM: 1.2, // F 1.207 / R 1.194
  tireRadiusM: 0.2, // Hoosier 16x7.5-10, loaded radius ≈ 0.20 m
  muLong: 1.5, // estimate (Hoosier R20 slick)
  muLat: 1.5, // estimate
  cdaM2: 1.24, // Cd 1.22 × ref area 1.02 m²
  claM2: 3.09, // Cl 3.03 × 1.02 m² (downforce)
  airDensityKgM3: 1.162,
  crr: 0.02,
  drivetrainEff: 0.85,
  gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208], // stock CBR600RR (PC40)
  primaryReduction: 2.111, // 76/36
  finalDrive: 3.0, // SDM sprocket choice (spec sheet "Final Drive Ratio 3:1")
  shiftRpm: 9500, // estimate (no longer drives accel shifts — those are optimal)
  revLimitRpm: 14500, // redline (confirmed by Nick)
  shiftTimeS: 0.1, // 100 ms (confirmed by Nick)
};

export const EMPTY_BASELINE: ReferenceBaseline = {
  accelTMin: null,
  autocrossTMin: null,
  enduranceTMin: null,
  co2MinPerLap: null,
  co2MaxPerLap: null,
};

/** Total reduction (engine → wheel) in gear `gearIdx`: primary × gear × final. */
export function totalReduction(vehicle: VehicleConfig, gearIdx: number): number {
  const g = vehicle.gearRatios[gearIdx];
  if (g == null || g <= 0) return 0;
  return vehicle.primaryReduction * g * vehicle.finalDrive;
}

/** Effective vehicle speed (m/s) per engine rpm in gear `gearIdx`:
 *  v/rpm = 2π·r_tire / (60 · totalReduction). */
export function gearVps(vehicle: VehicleConfig, gearIdx: number): number {
  const total = totalReduction(vehicle, gearIdx);
  if (total <= 0) return 0;
  return (2 * Math.PI * vehicle.tireRadiusM) / (60 * total);
}

/** Top speed (m/s) the gearing allows: fastest gear spun to the rev limit. */
export function topSpeedMps(vehicle: VehicleConfig): number {
  let v = 0;
  for (let i = 0; i < vehicle.gearRatios.length; i++) {
    v = Math.max(v, gearVps(vehicle, i) * vehicle.revLimitRpm);
  }
  return v;
}

/** SDM25 — same chassis/engine family as SDM26 but ran a 3.5 final drive
 *  (shorter than SDM26's 3.0 → revs out sooner, more/earlier shifts). */
export const SDM25_VEHICLE: VehicleConfig = {
  ...SDM26_VEHICLE,
  name: "SDM25",
  finalDrive: 3.5,
};

/** Classify a loaded config name into a vehicle "car" key so the right preset
 *  (and final drive) is applied automatically. */
export function carKeyForConfig(configName: string): string {
  const n = (configName || "").toLowerCase();
  if (n.includes("sdm25")) return "SDM25";
  if (n.includes("sdm26")) return "SDM26";
  return configName || "Default";
}

/** Vehicle preset for a car key (SDM25 → 3.5 final drive, SDM26 → 3.0). Unknown
 *  configs fall back to the SDM26 chassis under their own name. */
export function vehiclePresetForKey(key: string): VehicleConfig {
  if (key === "SDM25") return SDM25_VEHICLE;
  if (key === "SDM26") return SDM26_VEHICLE;
  return { ...SDM26_VEHICLE, name: key };
}
