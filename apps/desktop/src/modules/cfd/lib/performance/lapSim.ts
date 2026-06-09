// Quasi-steady-state (QSS) 2D lap sim. Standard three-step method:
//   1. corner-speed ceiling at each station from lateral grip (with aero
//      downforce raising grip at speed — closed form);
//   2. a forward pass accelerating out of corners, limited by the engine
//      tractive force AND the longitudinal grip left after lateral use
//      (friction-circle / combined grip);
//   3. a backward pass braking into corners, grip-limited.
// v(s) = min(corner, forward, backward). Lap time = Σ ds/v.
//
// Fuel is an ENERGY estimate (no BSFC map): positive propulsive work over the
// lap ÷ thermal efficiency ÷ LHV → mass → litres → CO₂. Approximate but
// monotonic in the things that matter (drag, mass, lap work). Flagged as such.
//
// Closed loops are solved by replicating the track 3× and reading the middle
// lap, which converges the periodic start/finish speed without index wrapping.

import type { VehicleConfig } from "./types";
import { topSpeedMps, gearVps, gearForSpeed } from "./vehicle";
import { tractiveForceInGear, resistanceForce, G } from "./tractive";
import type { TorqueCurve } from "./torqueCurve";
import { discretizeTrack, type Track } from "./track";

/** Rich per-event telemetry the lap sim now exposes (display + accuracy debug).
 *  All aggregates are time-weighted over the lap unless noted. */
export interface LapTelemetry {
  /** Time-weighted mean engine RPM over the lap. */
  avgRpm: number;
  /** Peak engine RPM reached (≤ rev limit). */
  maxRpm: number;
  /** Number of upshifts over the lap (each costs `shiftTimeS`). */
  shiftCount: number;
  /** Fraction of lap TIME spent in each gear (index = gear). Sums to ~1. */
  timeInGearFrac: number[];
  /** Peak lateral acceleration (g) — the grip-limited corners. */
  maxLatG: number;
  /** Peak longitudinal accel (g) under power. */
  maxAccelG: number;
  /** Peak longitudinal decel (g) under braking. */
  maxBrakeG: number;
  /** Fraction of lap TIME on throttle (accelerating) vs braking/coasting. */
  pctOnThrottle: number;
  /** Top / minimum speed over the lap (km/h), for the readout. */
  vMaxKph: number;
  vMinKph: number;
}

export interface LapResult {
  lapTimeS: number;
  fuelKg: number;
  fuelL: number;
  co2Kg: number;
  avgSpeedMps: number;
  vMaxMps: number;
  vMinMps: number;
  /** Number of upshifts over the lap (each costs `shiftTimeS` of dead time). */
  shiftCount: number;
  /** Rich per-lap telemetry (avg/max RPM, gear usage, g's, throttle fraction). */
  telemetry: LapTelemetry;
}

export interface LapOpts {
  ds?: number;
  /** Thermal efficiency for the energy→fuel estimate (default 0.30). */
  thermalEff?: number;
  /** Fuel lower heating value, MJ/kg (gasoline ≈ 43). */
  fuelLhvMJkg?: number;
  /** Fuel density, kg/L (gasoline ≈ 0.745). */
  fuelDensityKgL?: number;
  /** CO₂ per litre, kg/L (gasoline 2.31, E85 1.65 per §D.13.4.1). */
  co2PerL?: number;
  /** Race-pace fraction (0..1, default 1 = flat-out qualifying lap). Models the
   *  endurance regime: over a 22 km run on degrading tires, cone-bounded and
   *  managed for reliability + fuel, the driver holds a fraction of the absolute
   *  limit. Scales the whole speed envelope (corner ceilings AND top-speed cap),
   *  so it lowers BOTH cornering and straight-line speed — which a pure throttle
   *  cut can't, because corners are grip-limited. Slower speeds also cut drag
   *  work → fuel. Autocross runs at 1.0; endurance below it. */
  pace?: number;
}

export function simLap(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  track: Track,
  opts: LapOpts = {},
): LapResult {
  const { radius, step, length } = discretizeTrack(track, opts.ds ?? 2);
  const { v, shiftCount } = solveSpeeds(curve, vehicle, radius, step, track.closed, opts.pace ?? 1);
  const N = v.length;
  const nSeg = track.closed ? N : N - 1;
  const nGears = vehicle.gearRatios.length;

  let time = 0;
  let work = 0;
  // Telemetry accumulators (time-weighted).
  let sumRpmDt = 0;
  let maxRpm = 0;
  let maxLatG = 0;
  let maxAccelG = 0;
  let maxBrakeG = 0;
  let onThrottleDt = 0;
  const timeInGear = new Array<number>(nGears).fill(0);

  for (let i = 0; i < nSeg; i++) {
    const vi = v[i]!;
    const vn = v[(i + 1) % N]!;
    const vAvg = Math.max(0.1, (vi + vn) / 2);
    const dt = step / vAvg;
    time += dt;
    const a = (vn * vn - vi * vi) / (2 * step);
    const fEngine = vehicle.massKg * a + resistanceForce(vehicle, vAvg);
    if (fEngine > 0) work += fEngine * step; // propulsive work only (off-throttle = 0)

    // Per-segment telemetry: the gear/RPM the car is actually in at this speed.
    const gear = gearForSpeed(vehicle, vAvg);
    const vps = gearVps(vehicle, gear);
    const rpm = vps > 0 ? Math.min(vAvg / vps, vehicle.revLimitRpm) : 0;
    sumRpmDt += rpm * dt;
    if (rpm > maxRpm) maxRpm = rpm;
    if (gear >= 0 && gear < nGears) timeInGear[gear]! += dt;
    if (a > 0) { onThrottleDt += dt; if (a / G > maxAccelG) maxAccelG = a / G; }
    else if (-a / G > maxBrakeG) maxBrakeG = -a / G;
    const R = radius[i]!;
    const latG = Number.isFinite(R) && R > 0 ? vAvg * vAvg / R / G : 0;
    if (latG > maxLatG) maxLatG = latG;
  }
  // 100 ms (shiftTimeS) of dead time per upshift, added to the lap.
  time += shiftCount * Math.max(0, vehicle.shiftTimeS);

  const thermalEff = opts.thermalEff ?? 0.3;
  const lhv = (opts.fuelLhvMJkg ?? 43) * 1e6; // J/kg
  const density = opts.fuelDensityKgL ?? 0.745;
  const co2PerL = opts.co2PerL ?? 2.31;
  const fuelKg = work / (thermalEff * lhv);
  const fuelL = fuelKg / density;

  const dtTot = time - shiftCount * Math.max(0, vehicle.shiftTimeS); // moving time
  const telemetry: LapTelemetry = {
    avgRpm: dtTot > 0 ? sumRpmDt / dtTot : 0,
    maxRpm,
    shiftCount,
    timeInGearFrac: dtTot > 0 ? timeInGear.map((t) => t / dtTot) : timeInGear,
    maxLatG,
    maxAccelG,
    maxBrakeG,
    pctOnThrottle: dtTot > 0 ? onThrottleDt / dtTot : 0,
    vMaxKph: Math.max(...v) * 3.6,
    vMinKph: Math.min(...v) * 3.6,
  };

  return {
    lapTimeS: time,
    fuelKg,
    fuelL,
    co2Kg: fuelL * co2PerL,
    avgSpeedMps: time > 0 ? length / time : 0,
    vMaxMps: Math.max(...v),
    vMinMps: Math.min(...v),
    shiftCount,
    telemetry,
  };
}

/** Solve v(s) for one lap. `closed` replicates 3× and returns the middle lap.
 *  `pace` (0..1) scales the speed envelope (corner ceilings + top-speed cap) for
 *  the endurance race-pace regime (1 = flat-out). */
function solveSpeeds(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  radius: number[],
  ds: number,
  closed: boolean,
  pace: number,
): { v: number[]; shiftCount: number } {
  const N = radius.length;
  const reps = closed ? 3 : 1;
  const M = N * reps;
  const m = vehicle.massKg;
  const rad = (i: number): number => radius[((i % N) + N) % N]!;
  const vCap = Math.max(topSpeedMps(vehicle), 1) * 1.1;

  // Downforce normal-accel coefficient: aero adds grip ∝ v².
  const k = (0.5 * vehicle.airDensityKgM3 * vehicle.claM2) / m;
  const gEff = (v: number): number => G + k * v * v;

  // Steady-state corner speed (lateral grip incl. downforce, closed form).
  const vCorner = (R: number): number => {
    if (!Number.isFinite(R) || R <= 0) return vCap;
    const denom = 1 - vehicle.muLat * R * k;
    const v2 = denom > 1e-6 ? (vehicle.muLat * R * G) / denom : Number.POSITIVE_INFINITY;
    return Math.min(vCap, Math.sqrt(Math.max(0, v2)));
  };
  // Race-pace fraction scales the whole target-speed envelope (corners + the
  // top-speed cap that vCorner returns on straights), modeling managed endurance
  // pace; the engine still pulls at full force up to that lowered ceiling.
  const ceil = (i: number): number => pace * vCorner(rad(i));

  // Longitudinal accel/brake available after lateral grip is spent (ellipse).
  const aLongGrip = (v: number, R: number, mu: number): number => {
    const ge = gEff(v);
    const latCap = vehicle.muLat * ge;
    const aLat = Number.isFinite(R) && R > 0 ? (v * v) / R : 0;
    const frac = latCap > 0 ? Math.min(1, aLat / latCap) : 0;
    return mu * ge * Math.sqrt(Math.max(0, 1 - frac * frac));
  };

  const vf = new Array<number>(M);
  const vb = new Array<number>(M);

  // Forward pass (acceleration out of corners), GEAR-EXPLICIT: the car uses the
  // gear it would actually be in at the entry speed (gearForSpeed = ride each
  // gear to redline, then upshift), so the tractive force is that gear's force
  // at its real RPM — NOT the optimistic best-across-gears envelope. This
  // captures the post-upshift "bog" (engine drops to the bottom of the next
  // gear) and makes acceleration honestly gearing-dependent.
  vf[0] = closed ? ceil(0) : 0;
  for (let i = 1; i < M; i++) {
    const vEntry = Math.min(vf[i - 1]!, ceil(i - 1));
    const gear = gearForSpeed(vehicle, vEntry);
    const fEng = tractiveForceInGear(curve, vehicle, gear, vEntry);
    const fGrip = m * aLongGrip(vEntry, rad(i - 1), vehicle.muLong);
    const aAcc = (Math.min(fEng, fGrip) - resistanceForce(vehicle, vEntry)) / m;
    vf[i] = Math.min(ceil(i), Math.sqrt(Math.max(0, vEntry * vEntry + 2 * aAcc * ds)));
  }

  // Backward pass (braking into corners).
  vb[M - 1] = closed ? ceil(M - 1) : Math.min(ceil(M - 1), vf[M - 1]!);
  for (let i = M - 2; i >= 0; i--) {
    const vEntry = Math.min(vb[i + 1]!, ceil(i + 1));
    const aBrk = aLongGrip(vEntry, rad(i + 1), vehicle.muLong);
    vb[i] = Math.min(ceil(i), Math.sqrt(Math.max(0, vEntry * vEntry + 2 * aBrk * ds)));
  }

  const off = closed ? N : 0; // middle lap for closed loops
  const out = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    const j = i + off;
    out[i] = Math.max(0.1, Math.min(vf[j]!, vb[j]!, ceil(j)));
  }

  // Upshift count over the (middle) lap: where the forward-pass accel profile
  // climbs into a taller gear. Counted on vf (the acceleration trace) so corner
  // braking downshifts don't count and numerical ripple can't (vf rises
  // monotonically within an accel zone, then is capped at corners).
  let shiftCount = 0;
  for (let i = off + 1; i < off + N; i++) {
    const gPrev = gearForSpeed(vehicle, Math.min(vf[i - 1]!, ceil(i - 1)));
    const gCur = gearForSpeed(vehicle, Math.min(vf[i]!, ceil(i)));
    if (gCur > gPrev) shiftCount += gCur - gPrev;
  }

  return { v: out, shiftCount };
}
