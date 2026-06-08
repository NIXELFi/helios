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
import { topSpeedMps } from "./vehicle";
import { tractiveEnvelope, resistanceForce, G } from "./tractive";
import type { TorqueCurve } from "./torqueCurve";
import { discretizeTrack, type Track } from "./track";

export interface LapResult {
  lapTimeS: number;
  fuelKg: number;
  fuelL: number;
  co2Kg: number;
  avgSpeedMps: number;
  vMaxMps: number;
  vMinMps: number;
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
}

export function simLap(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  track: Track,
  opts: LapOpts = {},
): LapResult {
  const { radius, step, length } = discretizeTrack(track, opts.ds ?? 2);
  const v = solveSpeeds(curve, vehicle, radius, step, track.closed);
  const N = v.length;
  const nSeg = track.closed ? N : N - 1;

  let time = 0;
  let work = 0;
  for (let i = 0; i < nSeg; i++) {
    const vi = v[i]!;
    const vn = v[(i + 1) % N]!;
    const vAvg = Math.max(0.1, (vi + vn) / 2);
    time += step / vAvg;
    const a = (vn * vn - vi * vi) / (2 * step);
    const fEngine = vehicle.massKg * a + resistanceForce(vehicle, vAvg);
    if (fEngine > 0) work += fEngine * step; // propulsive work only (off-throttle = 0)
  }

  const thermalEff = opts.thermalEff ?? 0.3;
  const lhv = (opts.fuelLhvMJkg ?? 43) * 1e6; // J/kg
  const density = opts.fuelDensityKgL ?? 0.745;
  const co2PerL = opts.co2PerL ?? 2.31;
  const fuelKg = work / (thermalEff * lhv);
  const fuelL = fuelKg / density;

  return {
    lapTimeS: time,
    fuelKg,
    fuelL,
    co2Kg: fuelL * co2PerL,
    avgSpeedMps: time > 0 ? length / time : 0,
    vMaxMps: Math.max(...v),
    vMinMps: Math.min(...v),
  };
}

/** Solve v(s) for one lap. `closed` replicates 3× and returns the middle lap. */
function solveSpeeds(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  radius: number[],
  ds: number,
  closed: boolean,
): number[] {
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
  const ceil = (i: number): number => vCorner(rad(i));

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

  // Forward pass (acceleration out of corners).
  vf[0] = closed ? ceil(0) : 0;
  for (let i = 1; i < M; i++) {
    const vEntry = Math.min(vf[i - 1]!, ceil(i - 1));
    const fEng = tractiveEnvelope(curve, vehicle, vEntry).force;
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
  return out;
}
