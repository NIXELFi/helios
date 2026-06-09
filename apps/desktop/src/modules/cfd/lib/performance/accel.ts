// 75 m acceleration event (§D.9) — forward time integration of a point mass,
// gear by gear. Shift points are OPTIMAL: upshift the instant the next gear
// makes more tractive force at the current speed (the crossover of the gears'
// force curves on the tractive map), or when the current gear hits the rev
// limit. Sequential, up-only. Each shift is recorded so the UI can show the
// schedule. v1: shifts are instantaneous (no shift-time penalty); grip static.

import type { VehicleConfig } from "./types";
import { gearVps } from "./vehicle";
import { resistanceForce, tractionLimit, tractiveForceInGear } from "./tractive";
import type { TorqueCurve } from "./torqueCurve";

export interface AccelSample {
  t: number;
  x: number;
  v: number;
  rpm: number;
  gear: number; // 1-based
}

export interface ShiftPoint {
  fromGear: number; // 1-based
  toGear: number; // 1-based
  speedMps: number;
  /** Engine rpm in the OLD gear at the shift (the rev you pull the next gear at). */
  shiftRpm: number;
  /** Engine rpm you drop to in the NEW gear. */
  landRpm: number;
  distanceM: number;
  timeS: number;
}

export interface AccelResult {
  /** Time to cover the distance (s). `finished=false` if it stalled out. */
  timeS: number;
  finished: boolean;
  trapSpeedMps: number;
  finishGear: number; // 1-based
  trace: AccelSample[];
  shiftPoints: ShiftPoint[];
}

export interface AccelOpts {
  distanceM?: number;
  dt?: number;
  maxT?: number;
  /** Approx number of trace samples to keep (decimated). */
  traceSamples?: number;
}

/** Time (s) to cover from (x0, v0) to `distance` staying in ONE gear (no further
 *  shifts) — used to judge whether a candidate upshift actually pays back its
 *  shift-time coast before the finish. Coarse dt; decision-only. */
function projectFixedGear(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  x0: number,
  v0: number,
  gear: number,
  distance: number,
  maxT: number,
): number {
  const dt = 0.01;
  let x = x0;
  let v = v0;
  let t = 0;
  let guard = 0;
  while (x < distance && t < maxT && guard++ < 5000) {
    const f = tractiveForceInGear(curve, vehicle, gear, v);
    const net = Math.min(f, tractionLimit(vehicle, v)) - resistanceForce(vehicle, v);
    v = Math.max(0, v + (net / vehicle.massKg) * dt);
    x += v * dt;
    t += dt;
  }
  return t;
}

export function simAccel(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  opts: AccelOpts = {},
): AccelResult {
  const distance = opts.distanceM ?? 75;
  const dt = opts.dt ?? 0.002;
  const maxT = opts.maxT ?? 30;
  const nGears = vehicle.gearRatios.length;
  const maxSteps = Math.ceil(maxT / dt) + 10;
  const sampleEvery = Math.max(1, Math.floor(maxSteps / (opts.traceSamples ?? 300)));

  let t = 0;
  let x = 0;
  let v = 0;
  let gear = 0; // 0-based
  let shiftTimer = 0; // > 0 while a gearshift is in progress (no drive torque)
  const trace: AccelSample[] = [];
  const shiftPoints: ShiftPoint[] = [];

  const rpmInGear = (g: number, speed: number): number => {
    const vps = gearVps(vehicle, g);
    return vps > 0 ? speed / vps : 0;
  };
  const sample = () => {
    trace.push({ t, x, v, rpm: rpmInGear(gear, v), gear: gear + 1 });
  };

  sample();
  let step = 0;
  while (x < distance && t < maxT && step < maxSteps) {
    // Optimal upshift decision (sequential, up only): take the next gear once
    // it would make more tractive force at this speed — the crossover on the
    // tractive map — or once the current gear is pinned at the rev limit.
    if (shiftTimer <= 0 && gear < nGears - 1) {
      const rpmCur = rpmInGear(gear, v);
      const fCur = tractiveForceInGear(curve, vehicle, gear, v); // 0 once past the rev limit
      const fNext = tractiveForceInGear(curve, vehicle, gear + 1, v);
      // Consider an upshift once the next gear makes more force — the tractive
      // crossover, and also once the current gear is past the rev limit (fCur=0).
      // Take it only if, after the shift-time coast, the next gear reaches the
      // finish sooner than riding the current gear out. So the last usable gear
      // is ridden to the line (bouncing off the limiter if need be) rather than
      // grabbing a higher gear for no payback — i.e. "shift 1-2-3-4, ride 4th".
      if (fNext > 0 && fNext > fCur) {
        const remainT = maxT - t;
        const tStay = projectFixedGear(curve, vehicle, x, v, gear, distance, remainT);
        const vAfter = Math.max(0, v - (resistanceForce(vehicle, v) / vehicle.massKg) * vehicle.shiftTimeS);
        const xAfter = x + v * vehicle.shiftTimeS;
        const tShift = vehicle.shiftTimeS + projectFixedGear(curve, vehicle, xAfter, vAfter, gear + 1, distance, remainT);
        if (tShift < tStay) {
          const fromG = gear;
          gear += 1;
          shiftTimer = vehicle.shiftTimeS;
          shiftPoints.push({
            fromGear: fromG + 1,
            toGear: gear + 1,
            speedMps: v,
            shiftRpm: rpmCur,
            landRpm: rpmInGear(gear, v),
            distanceM: x,
            timeS: t,
          });
        }
      }
    }
    // No drive torque while the shift is in progress (coast against drag/roll).
    const fGear = shiftTimer > 0 ? 0 : tractiveForceInGear(curve, vehicle, gear, v);
    if (shiftTimer > 0) shiftTimer -= dt;
    const net = Math.min(fGear, tractionLimit(vehicle, v)) - resistanceForce(vehicle, v);
    const a = net / vehicle.massKg;
    v = Math.max(0, v + a * dt);
    x += v * dt;
    t += dt;
    step++;
    if (step % sampleEvery === 0) sample();
  }
  sample();

  return {
    timeS: t,
    finished: x >= distance,
    trapSpeedMps: v,
    finishGear: gear + 1,
    trace,
    shiftPoints,
  };
}
