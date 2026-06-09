// Vehicle presets + gearing helpers. Gearing is the explicit drivetrain:
// engine → primary reduction → gearbox ratio → final drive (sprocket) → wheel,
// so a sprocket swap (finalDrive) or a tire change recomputes everything.

import type { ReferenceBaseline, VehicleConfig } from "./types";

/** SDM26 (ASU Car #106) — chassis/aero from the 2026 FSAE spec sheet; gearbox =
 *  stock Honda CBR600RR (PC40) ratios + 2.111 primary, with SDM's 3.0 final
 *  drive. muLat is calibrated so the flat-out autocross lap reproduces SDM26's
 *  real 2026 time (42.922 s, 90.4 pts); muLong stays at the launch-traction
 *  estimate that lands the 75 m accel at ~4.2 s. */
export const SDM26_VEHICLE: VehicleConfig = {
  name: "SDM26",
  massKg: 267, // 199 kg car (confirmed by Nick) + 68 kg driver
  weightDistFront: 0.485, // with 68 kg driver
  cgHeightM: 0.2845,
  wheelbaseM: 1.53,
  trackWidthM: 1.2, // F 1.207 / R 1.194
  tireRadiusM: 0.2, // Hoosier 16x7.5-10, loaded radius ≈ 0.20 m
  muLong: 1.5, // launch-traction estimate (accel ≈ 4.2 s, matches real)
  tireLoadSensitivity: 0.15, // Hoosier R20 slick — flattens grip-vs-load (aero)
  muLat: 1.55, // Hoosier R20 slick — a REALISTIC mechanical μ. The autocross
  //            time is hit via the racing line (events.LINE_FACTOR), not inflated
  //            grip, so peak cornering lands a realistic ~2.2 g (× aero g_eff).
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
  effMin: null,
  effMax: null,
};

/** Real 2026 FSAE field anchors used to project points. Autocross Tmin is
 *  back-solved from SDM26's run (42.922 s → 90.39 pts → Tmin ≈ 39.04 s); the
 *  endurance/efficiency anchors are the published field min/max (the efficiency
 *  "Maximum" time 206.024 s = 1.45 × Tmin 142.085 s confirms the eligibility
 *  cap). accelTMin unknown → left null. */
export const REFERENCE_2026: ReferenceBaseline = {
  accelTMin: null,
  autocrossTMin: 39.04,
  enduranceTMin: 142.085,
  co2MinPerLap: 0.5893,
  co2MaxPerLap: 1.3214,
  effMin: 0.308,
  effMax: 0.839,
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

/** The gear a driver would be in at speed `v` (m/s): the shortest gear (most
 *  wheel force) whose engine RPM at `v` stays at or below the rev limit — i.e.
 *  you ride each gear to redline, then upshift. Returns the top gear when even
 *  it over-revs (the car is at its speed ceiling). Assumes gearRatios are
 *  ordered 1st→top (descending ratio, ascending speed-per-rpm). */
export function gearForSpeed(vehicle: VehicleConfig, v: number): number {
  const top = vehicle.gearRatios.length - 1;
  for (let g = 0; g <= top; g++) {
    const vps = gearVps(vehicle, g);
    if (vps > 0 && vps * vehicle.revLimitRpm >= v) return g;
  }
  return Math.max(0, top);
}

/** Top speed (m/s) the gearing allows: fastest gear spun to the rev limit. */
export function topSpeedMps(vehicle: VehicleConfig): number {
  let v = 0;
  for (let i = 0; i < vehicle.gearRatios.length; i++) {
    v = Math.max(v, gearVps(vehicle, i) * vehicle.revLimitRpm);
  }
  return v;
}

/** SDM25 — same chassis/engine family as SDM26 but HEAVIER (469 lb ≈ 213 kg car,
 *  confirmed by Nick, vs SDM26's 199 kg) and a shorter 3.5 final drive (vs 3.0 →
 *  revs out sooner, so more shifts → more 100 ms shift cuts in the lap sim). Both
 *  the extra mass and the extra shifts make it slower than SDM26 here. */
export const SDM25_VEHICLE: VehicleConfig = {
  ...SDM26_VEHICLE,
  name: "SDM25",
  massKg: 281, // 469 lb (≈213 kg car) + 68 kg driver
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

/** Car-IDENTITY fields that are fixed facts of a real car (not tuning knobs):
 *  the mass, gearing, and tire size that make an SDM25 an SDM25. These always
 *  come from the preset for a known car — so SDM25 weighs 281 kg and runs a 3.5
 *  final drive AUTOMATICALLY, exactly like the final drive already did, no
 *  matter what stale/edited `vehicleConfig` is in state. */
const IDENTITY_KEYS = [
  "massKg",
  "finalDrive",
  "gearRatios",
  "primaryReduction",
  "tireRadiusM",
  "revLimitRpm",
] as const;

/** Resolve the vehicle to SCORE a config of `carKey` with, given the user's
 *  current (possibly edited or stale-persisted) `vehicleConfig`. For a known
 *  car the identity fields are forced from the preset (auto-correct weight +
 *  gearing); the user's tuning of everything else (grip, aero, Crr, driveline,
 *  geometry) is preserved when it's the matching car. Unknown configs just use
 *  the persisted config (or the fallback preset). */
export function vehicleForCar(
  carKey: string,
  persisted: VehicleConfig | null | undefined,
): VehicleConfig {
  const preset = vehiclePresetForKey(carKey);
  const isKnown = carKey === "SDM25" || carKey === "SDM26";
  // Start from the user's config when it's for THIS car (keeps their tuning),
  // else from the preset.
  const base = persisted && persisted.name === carKey ? { ...persisted } : { ...preset };
  if (isKnown) for (const k of IDENTITY_KEYS) (base as Record<string, unknown>)[k] = preset[k];
  base.name = carKey;
  return base;
}
