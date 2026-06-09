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

/** What binds the car at a point on the lap. "power" = the engine's tractive
 *  force is the limit (more torque here = lap time); "grip" = traction-limited
 *  corner exit (more power would just spin); "corner" = at the lateral-grip
 *  speed ceiling; "brake" = decelerating into a corner; "coast" = none binding
 *  (e.g. at the paced speed cap). */
export type LimitState = "power" | "grip" | "corner" | "brake" | "coast";

/** Full per-distance channel traces from one lap solve — the data layer for the
 *  Lap Sim view and the CSV export. One sample per integration segment (~ds
 *  apart). Only produced when `LapOpts.channels` is set (the optimizer scores
 *  thousands of laps and must not pay for these arrays). */
export interface LapChannels {
  /** Distance from the start line at the sample (m). */
  distM: number[];
  /** Cumulative lap time at the sample (s), INCLUDING upshift dead time
   *  inserted where the upshift happens (so A/B time deltas localize shift
   *  losses). The final entry can differ from `lapTimeS` by at most a shift or
   *  two of dead time (shift counting on the final profile vs the accel pass). */
  tS: number[];
  vMps: number[];
  rpm: number[];
  /** Gear number, 1-based (1 = first). */
  gear: number[];
  latG: number[];
  /** Signed longitudinal acceleration (g); negative = braking. */
  longG: number[];
  /** What binds the car over this segment (see LimitState). */
  limit: LimitState[];
  /** Cumulative fuel burned (kg). Meaningful when fuel opts are supplied
   *  (endurance); still populated (relative shape) otherwise. */
  fuelCumKg: number[];
}

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
  /** Fraction of lap TIME where the ENGINE is the binding limit (more torque
   *  here would directly cut lap time). The engine team's leverage metric. */
  pctPowerLimited: number;
  /** Fraction of lap TIME spent at the lateral-grip corner ceiling (engine
   *  power is irrelevant here — chassis/tire territory). */
  pctCornerLimited: number;
  /** Top / minimum speed over the lap (km/h), for the readout. */
  vMaxKph: number;
  vMinKph: number;
}

/** Thermal efficiency RELATIVE to the engine's best-BSFC point, vs RPM. Real SI
 *  BSFC is U-shaped: best near peak-torque RPM, ~25-35% worse toward the rev
 *  limit (pumping + friction) and toward idle. So fuel is integrated per lap
 *  segment at the LOCAL engine RPM — short gearing (high RPM) burns more for the
 *  same work, which a single lumped efficiency couldn't capture. Parabolic in
 *  (rpm−sweet), floored so it never goes negative or silly. */
function bsfcEffMult(rpm: number, sweetRpm: number): number {
  const x = (rpm - sweetRpm) / 1000;
  return Math.max(0.6, 1 - 0.007 * x * x);
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
  /** Full per-distance traces — only present when `LapOpts.channels` was set. */
  channels?: LapChannels;
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
  /** Best-BSFC engine speed (rpm) — where the fuel map's thermal efficiency
   *  peaks (near peak torque/BMEP for an SI engine). Default 8000 (CBR600RR). */
  bsfcSweetRpm?: number;
  /** Racing-line factor (≥1): the driver's line through a corner has a LARGER
   *  effective radius than the traced centerline (clip the apex, use track
   *  width), so the car carries more corner speed at the SAME grip. Multiplies
   *  every finite corner radius. Default 1 = drive the centerline. This is what
   *  lets the tire μ stay realistic (~1.5) instead of being inflated to make the
   *  centerline-radius lap hit the real time. */
  lineFactor?: number;
  /** Race-pace fraction (0..1, default 1 = flat-out qualifying lap). Models the
   *  endurance regime: over a 22 km run on degrading tires, cone-bounded and
   *  managed for reliability + fuel, the driver holds a fraction of the absolute
   *  limit. Scales the whole speed envelope (corner ceilings AND top-speed cap),
   *  so it lowers BOTH cornering and straight-line speed — which a pure throttle
   *  cut can't, because corners are grip-limited. Slower speeds also cut drag
   *  work → fuel. Autocross runs at 1.0; endurance below it. */
  pace?: number;
  /** Emit full per-distance channel traces (LapResult.channels). Off by default
   *  — the optimizer scores thousands of laps and must not allocate these. */
  channels?: boolean;
}

// ---- Grip model -------------------------------------------------------------
// One shared closure set for "how much grip does the car have at speed v":
// aero downforce raises vertical load (gEff), tire load sensitivity discounts
// the μ gained from it (loadMult), and the friction circle splits what's left
// between lateral and longitudinal use. Used by BOTH the speed solver and the
// channel-limit classifier so they can never disagree about the physics.

export interface GripModel {
  /** Effective normal acceleration (m/s²): g + aero downforce / m. */
  gEff(v: number): number;
  /** Load-sensitivity discount on μ at speed v (≤1 above static). */
  loadMult(v: number): number;
  /** Lateral grip acceleration limit at v (m/s²). */
  latAccel(v: number): number;
  /** Longitudinal accel/brake available after lateral use (friction ellipse). */
  aLongGrip(v: number, R: number, mu: number): number;
  /** Steady-state corner-speed ceiling for radius R (un-paced), ≤ vCap. */
  vCorner(R: number): number;
  /** Speed cap (gearing top speed × 1.1) the solver clamps to. */
  vCap: number;
}

export function makeGripModel(vehicle: VehicleConfig): GripModel {
  const m = vehicle.massKg;
  const vCap = Math.max(topSpeedMps(vehicle), 1) * 1.1;

  // Downforce normal-accel coefficient: aero adds grip ∝ v². gEff/G is the ratio
  // of total vertical load (static + aero) to static — i.e. Fz/Fz_static.
  const k = (0.5 * vehicle.airDensityKgM3 * vehicle.claM2) / m;
  const gEff = (v: number): number => G + k * v * v;

  // Tire load sensitivity: μ falls as vertical load rises, so aero downforce
  // buys LESS grip than μ·Fz would imply. loadMult ≤ 1 for v > 0 (1 at static).
  // sens = 0 recovers the old load-independent (closed-form) behavior exactly.
  const sens = vehicle.tireLoadSensitivity ?? 0;
  const loadMult = (v: number): number => Math.pow(gEff(v) / G, -sens);
  // Load-sensitive lateral grip acceleration (m/s²) at the limit.
  const latAccel = (v: number): number => vehicle.muLat * loadMult(v) * gEff(v);

  // Steady-state corner speed: solve v²/R = latAccel(v). With load sensitivity
  // latAccel is sub-linear in Fz so there's no closed form — bisect (latAccel·R
  // − v² is +ve at v=0, −ve at high v → one root). Falls back to the speed cap
  // when grip would exceed it (straights).
  const vCorner = (R: number): number => {
    if (!Number.isFinite(R) || R <= 0) return vCap;
    const f = (v: number): number => latAccel(v) * R - v * v;
    if (f(vCap) >= 0) return vCap; // grip beats the cap → straight-line region
    let lo = 0;
    let hi = vCap;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    return Math.min(vCap, lo);
  };

  // Longitudinal accel/brake available after lateral grip is spent (ellipse),
  // with the same load-sensitive μ on both axes.
  const aLongGrip = (v: number, R: number, mu: number): number => {
    const ge = gEff(v);
    const lm = loadMult(v);
    const latCap = vehicle.muLat * lm * ge;
    const aLat = Number.isFinite(R) && R > 0 ? (v * v) / R : 0;
    const frac = latCap > 0 ? Math.min(1, aLat / latCap) : 0;
    return mu * lm * ge * Math.sqrt(Math.max(0, 1 - frac * frac));
  };

  return { gEff, loadMult, latAccel, aLongGrip, vCorner, vCap };
}

export function simLap(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  track: Track,
  opts: LapOpts = {},
): LapResult {
  const { radius: rawRadius, step, length } = discretizeTrack(track, opts.ds ?? 2);
  // Racing line: the driven path has a larger effective radius than the traced
  // centerline. Scale finite corner radii (straights stay Infinity). Both the
  // corner-speed solve AND the lateral-g telemetry then use the same effective
  // radius, so the car's actual lateral load stays grip-limited (μ·g_eff).
  const lineFactor = Math.max(1, opts.lineFactor ?? 1);
  const radius = rawRadius.map((r) => (Number.isFinite(r) && r > 0 ? r * lineFactor : r));
  const grip = makeGripModel(vehicle);
  const pace = opts.pace ?? 1;
  const { v, shiftCount } = solveSpeeds(curve, vehicle, grip, radius, step, track.closed, pace);
  const N = v.length;
  const nSeg = track.closed ? N : N - 1;
  const nGears = vehicle.gearRatios.length;

  const effPeak = opts.thermalEff ?? 0.3; // best-BSFC thermal efficiency
  const lhv = (opts.fuelLhvMJkg ?? 43) * 1e6; // J/kg
  const density = opts.fuelDensityKgL ?? 0.745;
  const co2PerL = opts.co2PerL ?? 2.31;
  const sweetRpm = opts.bsfcSweetRpm ?? 8000;

  let time = 0;
  let work = 0;
  let fuelKg = 0;
  // Telemetry accumulators (time-weighted).
  let sumRpmDt = 0;
  let maxRpm = 0;
  let maxLatG = 0;
  let maxAccelG = 0;
  let maxBrakeG = 0;
  let onThrottleDt = 0;
  let powerLimitedDt = 0;
  let cornerLimitedDt = 0;
  const timeInGear = new Array<number>(nGears).fill(0);

  // Channel collection (only when asked for — see LapOpts.channels).
  const ch: LapChannels | null = opts.channels
    ? { distM: [], tS: [], vMps: [], rpm: [], gear: [], latG: [], longG: [], limit: [], fuelCumKg: [] }
    : null;
  let tCh = 0; // channel clock: moving time + shift dead time AT the shift
  let prevGear = -1;

  for (let i = 0; i < nSeg; i++) {
    const vi = v[i]!;
    const vn = v[(i + 1) % N]!;
    const vAvg = Math.max(0.1, (vi + vn) / 2);
    const dt = step / vAvg;
    time += dt;

    // The gear/RPM the car is actually in at this speed (also drives the BSFC).
    const gear = gearForSpeed(vehicle, vAvg);
    const vps = gearVps(vehicle, gear);
    const rpm = vps > 0 ? Math.min(vAvg / vps, vehicle.revLimitRpm) : 0;

    const a = (vn * vn - vi * vi) / (2 * step);
    const fEngine = vehicle.massKg * a + resistanceForce(vehicle, vAvg);
    if (fEngine > 0) {
      const segWork = fEngine * step; // propulsive work only (off-throttle = 0)
      work += segWork;
      // Fuel burned for THIS segment at the engine's efficiency for its current
      // RPM — high-RPM (short-geared) running costs more fuel per joule.
      fuelKg += segWork / (effPeak * bsfcEffMult(rpm, sweetRpm) * lhv);
    }

    sumRpmDt += rpm * dt;
    if (rpm > maxRpm) maxRpm = rpm;
    if (gear >= 0 && gear < nGears) timeInGear[gear]! += dt;
    if (a > 0) { onThrottleDt += dt; if (a / G > maxAccelG) maxAccelG = a / G; }
    else if (-a / G > maxBrakeG) maxBrakeG = -a / G;
    const R = radius[i]!;
    const latG = Number.isFinite(R) && R > 0 ? vAvg * vAvg / R / G : 0;
    if (latG > maxLatG) maxLatG = latG;

    // Limit-state classification: WHAT bound the car over this segment. The
    // engine team's leverage map — "power" segments are where torque buys lap
    // time; "corner"/"grip" segments are chassis/tire territory. Uses the same
    // grip model as the solver, so the labels agree with the speeds.
    const aG = a / G;
    let limit: LimitState;
    if (aG < -0.05) {
      limit = "brake";
    } else if (vAvg >= 0.985 * pace * grip.vCorner(R)) {
      limit = "corner"; // riding the (paced) lateral ceiling / speed cap
    } else if (aG > 0.05) {
      const fAvail = tractiveForceInGear(curve, vehicle, gear, vAvg);
      const fGrip = vehicle.massKg * grip.aLongGrip(vAvg, R, vehicle.muLong);
      limit = fAvail <= fGrip ? "power" : "grip";
    } else {
      limit = "coast";
    }
    if (limit === "power") powerLimitedDt += dt;
    else if (limit === "corner") cornerLimitedDt += dt;

    if (ch) {
      // Insert the upshift dead time AT the shift so A/B deltas localize it.
      if (prevGear >= 0 && gear > prevGear) tCh += (gear - prevGear) * Math.max(0, vehicle.shiftTimeS);
      prevGear = gear;
      tCh += dt;
      ch.distM.push(i * step);
      ch.tS.push(tCh);
      ch.vMps.push(vAvg);
      ch.rpm.push(rpm);
      ch.gear.push(gear + 1); // 1-based for humans
      ch.latG.push(latG);
      ch.longG.push(aG);
      ch.limit.push(limit);
      ch.fuelCumKg.push(fuelKg);
    }
  }
  // 100 ms (shiftTimeS) of dead time per upshift, added to the lap.
  time += shiftCount * Math.max(0, vehicle.shiftTimeS);

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
    pctPowerLimited: dtTot > 0 ? powerLimitedDt / dtTot : 0,
    pctCornerLimited: dtTot > 0 ? cornerLimitedDt / dtTot : 0,
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
    ...(ch ? { channels: ch } : {}),
  };
}

/** Solve v(s) for one lap. `closed` replicates 3× and returns the middle lap.
 *  `pace` (0..1) scales the speed envelope (corner ceilings + top-speed cap) for
 *  the endurance race-pace regime (1 = flat-out). */
function solveSpeeds(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  grip: GripModel,
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
  const { vCorner, aLongGrip } = grip;

  // Race-pace fraction scales the whole target-speed envelope (corners + the
  // top-speed cap that vCorner returns on straights), modeling managed endurance
  // pace; the engine still pulls at full force up to that lowered ceiling.
  const ceil = (i: number): number => pace * vCorner(rad(i));

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

  // Backward pass (braking into corners). Braking loads ALL FOUR tires (with
  // forward weight transfer), so its grip is ~the lateral coefficient — NOT
  // muLong, which is the REAR-axle launch/corner-exit limit. Using muLong here
  // (the old behavior) under-braked the car and forced muLat up to recover lap
  // time, which inflated the predicted cornering g. Brake on muLat instead.
  vb[M - 1] = closed ? ceil(M - 1) : Math.min(ceil(M - 1), vf[M - 1]!);
  for (let i = M - 2; i >= 0; i--) {
    const vEntry = Math.min(vb[i + 1]!, ceil(i + 1));
    const aBrk = aLongGrip(vEntry, rad(i + 1), vehicle.muLat);
    vb[i] = Math.min(ceil(i), Math.sqrt(Math.max(0, vEntry * vEntry + 2 * aBrk * ds)));
  }

  const off = closed ? N : 0; // middle lap for closed loops
  const out = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    const j = i + off;
    out[i] = Math.max(0.1, Math.min(vf[j]!, vb[j]!, ceil(j)));
  }

  // Upshift count over the (middle) lap, on the DRIVEN profile (min of all
  // three passes). Counting on vf (the old behavior) overcounted: the forward
  // pass accelerates all the way to each corner before the cap, passing through
  // taller gears the driven car never reaches because it brakes earlier (vb).
  // Only gear INCREASES count, so braking downshifts are excluded; v is
  // monotone within an accel zone, so ripple can't double-count.
  let shiftCount = 0;
  for (let i = 1; i < N; i++) {
    const gPrev = gearForSpeed(vehicle, out[i - 1]!);
    const gCur = gearForSpeed(vehicle, out[i]!);
    if (gCur > gPrev) shiftCount += gCur - gPrev;
  }

  return { v: out, shiftCount };
}
