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
import { topSpeedMps, gearVps } from "./vehicle";
import {
  tractiveForceInGear,
  resistanceForce,
  optimalShiftSpeeds,
  gearAtSpeed,
  REAR_AERO_FRAC,
  G,
} from "./tractive";
import type { TorqueCurve } from "./torqueCurve";
import { tirMuLat, tirMuLong } from "./tir";
import { fuelFlowKgS, type EngineFuelMap } from "./fuelMap";
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
  /** Throttle demand 0..1: propulsive force required ÷ force available in the
   *  current gear (1 = wide open / power-limited). 0 while braking/coasting. */
  throttle: number[];
  /** Brake demand 0..1: brake force required (after drag's help) ÷ the grip
   *  model's braking capacity at this (v, R). 0 off the brakes. */
  brake: number[];
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
  /** Of the corner-limited time, the fraction where the FRONT axle is the
   *  saturating one (≈ understeer-limited). Only with a roll-balance model.
   *  0.5 = neutral; >0.5 = push-limited; <0.5 = rear-limited. NOTE: with a
   *  static weight bias + load-sensitive μ this saturates to 0 or 1 (the
   *  same axle wins every corner) — `balanceMargin` is the honest readout. */
  pctFrontLimited?: number;
  /** Time-weighted mean signed axle-capacity margin over corner-limited
   *  time: (capFront − capRear)/mean. +0.04 ⇒ the rear limits with the
   *  front holding ~4% spare ("loose by 4%"); negative ⇒ push. Only with a
   *  roll-balance model. */
  balanceMargin?: number;
  /** Energy dissipated by the BRAKES over the lap (kJ): ∫ max(0, m·|a| −
   *  drag − rolling) · v dt over decelerating segments — drag's share of the
   *  slowing is subtracted, so this is what the rotors actually absorb.
   *  Brake-sizing input. */
  brakeEnergyKJ: number;
  /** Peak instantaneous brake power (kW) — the worst single dissipation
   *  moment (end of the fastest straight). Brake thermal sizing input. */
  peakBrakePowerKw: number;
  /** Tire lateral-duty proxy (g·km): ∫ |a_lat|/g · v dt. Tracks how much
   *  cornering WORK the tires do per lap — an endurance-degradation /
   *  thermal-load comparator between designs (relative, not absolute). */
  tireDutyGkm: number;
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
  /** Physics-derived part-load fuel model (variable throttle) built from the
   *  source sweep (fuelMapFromSweep). When present it REPLACES the lumped
   *  thermalEff×BSFC fuel estimate with the Willans line measured by the 1D
   *  solver — zero calibration constants. Absent (synthetic/dyno curves) →
   *  the legacy thermal model. */
  fuelMap?: EngineFuelMap;
}

// ---- Grip model -------------------------------------------------------------
// One shared closure set for "how much grip does the car have at speed v":
// aero downforce raises vertical load (gEff), tire load sensitivity discounts
// the μ gained from it (loadMult), LATERAL load transfer discounts cornering
// capacity further (chi — outer tires gain less than inner tires lose, by the
// same load sensitivity), the friction ellipse splits what's left between
// lateral and longitudinal use, and DRIVE traction is the rear axle's (static
// rear weight + rear aero + longitudinal weight transfer, the same closed form
// as tractive.tractionLimit). Used by BOTH the speed solver and the
// channel-limit classifier so they can never disagree about the physics.

export interface GripModel {
  /** Effective normal acceleration (m/s²): g + aero downforce / m. */
  gEff(v: number): number;
  /** Load-sensitivity discount on μ at speed v (≤1 above static). */
  loadMult(v: number): number;
  /** Lateral-load-transfer capacity factor χ ≤ 1 at speed v on radius R. */
  chi(v: number, R: number): number;
  /** Lateral grip acceleration limit (m/s²) at v on radius R (incl. χ). */
  latCap(v: number, R: number): number;
  /** DRIVE traction accel (m/s²): rear axle + weight transfer + ellipse. */
  aDriveGrip(v: number, R: number): number;
  /** BRAKE deceleration (m/s²): all four tires with forward weight transfer
   *  (load-sensitivity-weighted per axle) + χ + ellipse. */
  aBrakeGrip(v: number, R: number): number;
  /** Steady-state corner-speed ceiling for radius R (un-paced), ≤ vCap. */
  vCorner(R: number): number;
  /** Speed cap (gearing top speed × 1.1) the solver clamps to. */
  vCap: number;
  /** Which axle saturates first at (v, R) — only when a roll-balance model
   *  is configured (per-axle limit). Undefined under the lumped model. */
  limitingAxle?(v: number, R: number): "front" | "rear";
  /** Signed axle-capacity margin at (v, R): (capFront − capRear) / mean.
   *  Positive = the front has spare capacity (rear limits → "loose");
   *  negative = front limits ("push"). Magnitude is how decisively. */
  axleMargin?(v: number, R: number): number;
}

export function makeGripModel(vehicle: VehicleConfig): GripModel {
  const m = vehicle.massKg;
  const vCap = Math.max(topSpeedMps(vehicle), 1) * 1.1;

  // Downforce normal-accel coefficient: aero adds grip ∝ v². gEff/G is the ratio
  // of total vertical load (static + aero) to static — i.e. Fz/Fz_static.
  const k = (0.5 * vehicle.airDensityKgM3 * vehicle.claM2) / m;
  const gEff = (v: number): number => G + k * v * v;

  // Measured tire model (imported .tir): μ(Fz) comes from the Pacejka peak-
  // friction fit instead of the constant-μ + power-law guess. Per-tire load
  // at speed v assumes even distribution (transfer is handled by χ below and
  // by the rear-axle closed form for drive traction).
  const tir = vehicle.tire;
  const fzTireStatic = (m * G) / 4;
  const fzTire = (v: number): number => fzTireStatic * (gEff(v) / G);
  const muLatV = (v: number): number =>
    tir ? tirMuLat(tir, fzTire(v)) : vehicle.muLat * loadMult(v);
  // Per-tire lateral μ at an arbitrary load — the .tir fit when imported,
  // else the power-law generalized to per-tire load (identical to the legacy
  // loadMult at even loading).
  const sensEarly = vehicle.tireLoadSensitivity ?? 0;
  const muLatFz = (fz: number): number =>
    tir
      ? tirMuLat(tir, fz)
      : vehicle.muLat * Math.pow(Math.max(fz, 1) / fzTireStatic, -sensEarly);

  // Tire load sensitivity: μ falls as vertical load rises, so aero downforce
  // buys LESS grip than μ·Fz would imply. loadMult ≤ 1 for v > 0 (1 at static).
  // sens = 0 recovers the old load-independent (closed-form) behavior exactly.
  const sens = vehicle.tireLoadSensitivity ?? 0;
  const loadMult = (v: number): number => Math.pow(gEff(v) / G, -sens);

  // Lateral load transfer × load sensitivity: cornering shifts load to the
  // outer tires, and the outer tires gain LESS grip than the inner tires
  // lose, so axle capacity drops. With a measured tire the pair factor is
  // capacity-weighted directly from μ(Fz): χ = [μ(Fz(1+δ))·(1+δ) +
  // μ(Fz(1−δ))·(1−δ)] / (2·μ(Fz)); for the power-law tire it reduces to the
  // closed form χ = ((1+δ)^(1−s) + (1−δ)^(1−s))/2. δ is the transferred
  // fraction of the pair's load: δ = a_lat·h_cg / (½·track·g_eff), clamped
  // at 1 (inner wheels unloaded). s = 0 (or δ = 0) gives χ = 1 — no effect.
  const chi = (v: number, R: number): number => {
    if (!Number.isFinite(R) || R <= 0) return 1;
    if (!tir && sens === 0) return 1;
    const aLat = (v * v) / R;
    const d = Math.min(1, (aLat * vehicle.cgHeightM) / (0.5 * vehicle.trackWidthM * gEff(v)));
    if (tir) {
      const fz = fzTire(v);
      const even = tirMuLat(tir, fz);
      if (even <= 0) return 1;
      return (
        (tirMuLat(tir, fz * (1 + d)) * (1 + d) + tirMuLat(tir, fz * (1 - d)) * (1 - d)) /
        (2 * even)
      );
    }
    return (Math.pow(1 + d, 1 - sens) + Math.pow(1 - d, 1 - sens)) / 2;
  };

  // ---- Per-axle cornering limit (roll-balance model) ------------------------
  // With a RollConfig, lateral load transfer splits by roll-stiffness
  // distribution + roll-center geometry: ΔF_axle = m·a_lat·(q·h_arm +
  // rc·w_static)/track (Milliken Ch 18 simplified, sprung≈total mass). Each
  // axle's capacity is the load-weighted μ(Fz) of its outer+inner tires; in
  // steady state each axle must react its load share of m·a_lat, so the car
  // saturates at min over axles — whichever gives up first sets the balance.
  const roll = vehicle.roll;
  const axleCaps = (v: number, R: number): { front: number; rear: number } => {
    const r = roll!;
    const aLat = Number.isFinite(R) && R > 0 ? (v * v) / R : 0;
    const aeroN = m * k * v * v;
    const wf = vehicle.weightDistFront;
    const W = m * G + aeroN;
    const caps = { front: 0, rear: 0 };
    for (const axle of ["front", "rear"] as const) {
      const isF = axle === "front";
      const wStatic = isF ? wf : 1 - wf;
      const Wa = m * G * wStatic + aeroN * (isF ? r.aeroFrontFrac : 1 - r.aeroFrontFrac);
      const q = isF ? r.rsdFront : 1 - r.rsdFront;
      const rc = isF ? r.rcFrontM : r.rcRearM;
      const dF = Math.min(Wa, (m * aLat * (q * r.hRollArmM + rc * wStatic)) / vehicle.trackWidthM);
      const out = Wa / 2 + dF / 2;
      const inn = Math.max(0, Wa / 2 - dF / 2);
      const fCap = muLatFz(out) * out + muLatFz(inn) * inn;
      // axle reacts its load share of the total lateral force m·a_lat
      caps[axle] = (fCap * W) / (m * Math.max(Wa, 1));
    }
    return caps;
  };

  // Load-sensitive, transfer-discounted lateral grip acceleration (m/s²).
  const latCap = (v: number, R: number): number => {
    if (roll) {
      const c = axleCaps(v, R);
      return Math.min(c.front, c.rear);
    }
    return muLatV(v) * gEff(v) * chi(v, R);
  };

  const limitingAxle = roll
    ? (v: number, R: number): "front" | "rear" => {
        const c = axleCaps(v, R);
        return c.front <= c.rear ? "front" : "rear";
      }
    : undefined;
  const axleMargin = roll
    ? (v: number, R: number): number => {
        const c = axleCaps(v, R);
        const mean = (c.front + c.rear) / 2;
        return mean > 0 ? (c.front - c.rear) / mean : 0;
      }
    : undefined;

  // Steady-state corner speed: solve v²/R = latCap(v, R). Load sensitivity and
  // χ make the capacity sub-linear in v with no closed form — bisect (capacity·R
  // − v² is +ve at v=0, −ve at high v → one root). Falls back to the speed cap
  // when grip would exceed it (straights).
  const vCorner = (R: number): number => {
    if (!Number.isFinite(R) || R <= 0) return vCap;
    const f = (v: number): number => latCap(v, R) * R - v * v;
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

  // Friction-ellipse fraction left for longitudinal use at (v, R).
  const ellipse = (v: number, R: number): number => {
    const cap = latCap(v, R);
    const aLat = Number.isFinite(R) && R > 0 ? (v * v) / R : 0;
    const frac = cap > 0 ? Math.min(1, aLat / cap) : 0;
    return Math.sqrt(Math.max(0, 1 - frac * frac));
  };

  // DRIVE traction (RWD): the rear axle's load — static rear weight + the rear
  // share of aero + longitudinal weight transfer (more thrust → more rear load;
  // closed form a = μ'·N_rear/(1 − μ'·h/L)) — with the ellipse discounting μ
  // for lateral use on corner exit. SAME physics as tractive.tractionLimit, so
  // the lap sim and the accel event finally agree on how the car launches.
  const rearStaticAccel = G * (1 - vehicle.weightDistFront);
  // Rear share of aero downforce: from the roll config's measured aero split
  // when present (the same split the per-axle cornering model uses — the two
  // models must not disagree about the same car), else the legacy constant.
  const kRear = k * (vehicle.roll ? 1 - vehicle.roll.aeroFrontFrac : REAR_AERO_FRAC);
  const aDriveGrip = (v: number, R: number): number => {
    // With a measured tire, μ comes from the rear per-tire load (pre-transfer;
    // the closed form below then folds the transfer in, same as before).
    const nRear = rearStaticAccel + kRear * v * v;
    const muBase = tir
      ? tirMuLong(tir, (m * nRear) / 2)
      : vehicle.muLong * loadMult(v);
    const muEff = muBase * ellipse(v, R);
    const denom = Math.max(1 - (muEff * vehicle.cgHeightM) / vehicle.wheelbaseM, 0.05);
    return (muEff * nRear) / denom;
  };

  // BRAKING loads ALL FOUR tires — but not evenly: forward weight transfer
  // piles m·a·h/L onto the fronts, and a load-sensitive tire gives back more μ
  // on the overloaded axle than it gains on the unloaded one, so real capacity
  // sits BELOW the ideal μ·g_eff. Solved as a fixed point in the decel (the
  // transfer depends on it; 4 iterations converge to <0.1%). χ then discounts
  // lateral transfer and the ellipse the lateral USE on corner entry — the
  // same treatment the cornering capacity gets (audit 0029 item #12).
  // sens = 0 with no .tir reduces EXACTLY to the legacy μ·g_eff.
  const aeroFrontFrac = vehicle.roll ? vehicle.roll.aeroFrontFrac : 1 - REAR_AERO_FRAC;
  const aBrakeStraight = (v: number): number => {
    let a = muLatV(v) * gEff(v); // legacy value = starting point
    if (!tir && sens === 0) return a;
    const N = m * gEff(v); // total vertical load at speed
    const aeroN = m * k * v * v;
    const Wf0 = m * G * vehicle.weightDistFront + aeroN * aeroFrontFrac;
    for (let it = 0; it < 4; it++) {
      const dF = Math.min(Math.max(0, N - Wf0), (m * a * vehicle.cgHeightM) / vehicle.wheelbaseM);
      const Ff = Math.min(N, Wf0 + dF);
      const Fr = Math.max(0, N - Ff);
      a = (muLatFz(Ff / 2) * Ff + muLatFz(Fr / 2) * Fr) / m;
    }
    return a;
  };
  const aBrakeGrip = (v: number, R: number): number =>
    aBrakeStraight(v) * chi(v, R) * ellipse(v, R);

  return { gEff, loadMult, chi, latCap, aDriveGrip, aBrakeGrip, vCorner, vCap, limitingAxle, axleMargin };
}

/** FSAE skidpad driving-path radius: 15.25 m inner diameter + half the 3 m
 *  lane (§D.10). */
export const SKIDPAD_PATH_RADIUS_M = 9.125;

/** Grip-model skidpad prediction — the cleanest validation point the rules
 *  offer, because skidpad isolates lateral grip: ~no aero (low speed), no
 *  line freedom, no engine. SDM26's real 5.02 s pins the default muLat;
 *  this prediction keeps that validation visible (and immediately flags a
 *  grip-model regression). */
export function predictSkidpad(vehicle: VehicleConfig): {
  timeS: number;
  speedKph: number;
  latG: number;
} {
  const v = makeGripModel(vehicle).vCorner(SKIDPAD_PATH_RADIUS_M);
  return {
    timeS: (2 * Math.PI * SKIDPAD_PATH_RADIUS_M) / v,
    speedKph: v * 3.6,
    latG: (v * v) / SKIDPAD_PATH_RADIUS_M / G,
  };
}

export function simLap(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  track: Track,
  opts: LapOpts = {},
): LapResult {
  const { radius: rawRadius, step, length } = discretizeTrack(track, opts.ds ?? 2);
  // Racing line: the driven path has a larger effective radius than the traced
  // centerline. Scale finite corner radii (straights stay Infinity) — but the
  // gain is PHYSICALLY BOUNDED: a driver buys radius with course width, and
  // geometry says full use of a ~3 m lane through a typical corner is worth
  // at most ~17 m of radius, no matter how big the corner. Without the cap a
  // multiplicative factor inflates 200 m+ sweepers by 30+ m of free radius,
  // which is where the spurious 6th-gear autocross speeds came from. Both the
  // corner-speed solve AND the lateral-g telemetry use the same effective
  // radius, so the car's actual lateral load stays grip-limited (μ·g_eff).
  const LINE_GAIN_CAP_M = 17;
  const lineFactor = Math.max(1, opts.lineFactor ?? 1);
  const radius = rawRadius.map((r) =>
    Number.isFinite(r) && r > 0 ? Math.min(r * lineFactor, r + LINE_GAIN_CAP_M) : r,
  );
  const grip = makeGripModel(vehicle);
  // vCorner bisects 40 steps per call; radii repeat (piecewise-constant track),
  // so cache per distinct radius for the telemetry loop's limit classifier.
  const vCornerCache = new Map<number, number>();
  const vCornerAt = (R: number): number => {
    let v = vCornerCache.get(R);
    if (v === undefined) {
      v = grip.vCorner(R);
      vCornerCache.set(R, v);
    }
    return v;
  };
  // Optimal shift schedule (tractive-force crossovers) — the same shift policy
  // the accel event uses, so the two sims drive the car the same way.
  const shiftV = optimalShiftSpeeds(curve, vehicle);
  const pace = opts.pace ?? 1;
  // Top-gear limiter speed — the same envelope cap solveSpeeds applies.
  const vLimiter = gearVps(vehicle, vehicle.gearRatios.length - 1) * vehicle.revLimitRpm;
  const { v, shiftCount } = solveSpeeds(curve, vehicle, grip, shiftV, radius, step, track.closed, pace);
  const N = v.length;
  const nSeg = track.closed ? N : N - 1;
  const nGears = vehicle.gearRatios.length;

  const effPeak = opts.thermalEff ?? 0.3; // best-BSFC thermal efficiency
  const lhv = (opts.fuelLhvMJkg ?? 43) * 1e6; // J/kg
  const density = opts.fuelDensityKgL ?? 0.745;
  const co2PerL = opts.co2PerL ?? 2.31;
  const sweetRpm = opts.bsfcSweetRpm ?? 8000;

  let time = 0;
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
  let frontLimitedDt = 0;
  let marginDtSum = 0;
  let brakeEnergyJ = 0;
  let peakBrakePowerW = 0;
  let tireDutyMs = 0; // ∫|a_lat|·v dt, m²/s²·s — converted to g·km at the end
  const timeInGear = new Array<number>(nGears).fill(0);

  // Channel collection (only when asked for — see LapOpts.channels).
  const ch: LapChannels | null = opts.channels
    ? { distM: [], tS: [], vMps: [], rpm: [], gear: [], latG: [], longG: [], limit: [], fuelCumKg: [], throttle: [], brake: [] }
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
    const gear = gearAtSpeed(shiftV, vAvg);
    const vps = gearVps(vehicle, gear);
    const rpm = vps > 0 ? Math.min(vAvg / vps, vehicle.revLimitRpm) : 0;

    const a = (vn * vn - vi * vi) / (2 * step);
    const fEngine = vehicle.massKg * a + resistanceForce(vehicle, vAvg);
    if (opts.fuelMap) {
      // Variable throttle (Willans, solver-derived): engine BRAKE power
      // demand = wheel power / driveline η, clamped to WOT inside the map.
      // Off-throttle segments still pay the friction floor (no DFCO).
      const pDemKw = fEngine > 0 ? (fEngine * vAvg) / (vehicle.drivetrainEff * 1000) : 0;
      fuelKg += fuelFlowKgS(opts.fuelMap, rpm, pDemKw, lhv) * dt;
    } else if (fEngine > 0) {
      // Legacy lumped model: fuel for this segment at the engine's efficiency
      // for its current RPM — high-RPM (short-geared) running costs more
      // fuel per joule.
      fuelKg += (fEngine * step) / (effPeak * bsfcEffMult(rpm, sweetRpm) * lhv);
    }

    sumRpmDt += rpm * dt;
    if (rpm > maxRpm) maxRpm = rpm;
    if (gear >= 0 && gear < nGears) timeInGear[gear]! += dt;
    if (a > 0) { onThrottleDt += dt; if (a / G > maxAccelG) maxAccelG = a / G; }
    else if (-a / G > maxBrakeG) maxBrakeG = -a / G;
    const R = radius[i]!;
    const latG = Number.isFinite(R) && R > 0 ? vAvg * vAvg / R / G : 0;
    if (latG > maxLatG) maxLatG = latG;

    // Duty accumulators (observation only — roadmap #11). Brake force is what
    // the pads must produce AFTER drag + rolling have done their share of the
    // slowing (fEngine < 0 ⇔ the engine can't absorb it): energy = F·ds.
    const fBrake = Math.max(0, -fEngine);
    if (fBrake > 0) {
      brakeEnergyJ += fBrake * step;
      const pBrake = fBrake * vAvg;
      if (pBrake > peakBrakePowerW) peakBrakePowerW = pBrake;
    }
    tireDutyMs += latG * G * vAvg * dt;

    // Limit-state classification: WHAT bound the car over this segment. The
    // engine team's leverage map — "power" segments are where torque buys lap
    // time; "corner"/"grip" segments are chassis/tire territory. Uses the same
    // grip model as the solver, so the labels agree with the speeds.
    const aG = a / G;
    // Paced ceiling, SAME rule as solveSpeeds: pace scales grip-limited corner
    // ceilings only — straights (gearing/aero-capped, vCorner ≥ vCap) run
    // flat-out. Applying pace unconditionally here mislabeled every endurance
    // straight above pace×vCap as "corner" and understated pctPowerLimited.
    const vCornerHere = vCornerAt(R);
    const vCeil = Math.min(
      vCornerHere < grip.vCap * 0.999 ? pace * vCornerHere : vCornerHere,
      vLimiter,
    );
    let limit: LimitState;
    if (aG < -0.05) {
      limit = "brake";
    } else if (vAvg >= 0.985 * vCeil) {
      limit = "corner"; // riding the (paced) lateral ceiling / speed cap
    } else if (aG > 0.05) {
      const fAvail = tractiveForceInGear(curve, vehicle, gear, vAvg);
      const fGrip = vehicle.massKg * grip.aDriveGrip(vAvg, R);
      limit = fAvail <= fGrip ? "power" : "grip";
    } else {
      limit = "coast";
    }
    if (limit === "power") powerLimitedDt += dt;
    else if (limit === "corner") {
      cornerLimitedDt += dt;
      // Balance bookkeeping: which axle binds, and by how much (roll model).
      if (grip.limitingAxle && Number.isFinite(R) && R > 0) {
        if (grip.limitingAxle(vAvg, R) === "front") frontLimitedDt += dt;
        if (grip.axleMargin) marginDtSum += grip.axleMargin(vAvg, R) * dt;
      }
    }

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
      // Pedal channels (demand ÷ capacity, same physics as the classifier).
      const fAvail = fEngine > 0 ? tractiveForceInGear(curve, vehicle, gear, vAvg) : 0;
      ch.throttle.push(fEngine > 0 && fAvail > 0 ? Math.min(1, fEngine / fAvail) : 0);
      const brakeCap = fBrake > 0 ? vehicle.massKg * grip.aBrakeGrip(vAvg, R) : 0;
      ch.brake.push(brakeCap > 0 ? Math.min(1, fBrake / brakeCap) : 0);
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
    brakeEnergyKJ: brakeEnergyJ / 1000,
    peakBrakePowerKw: peakBrakePowerW / 1000,
    tireDutyGkm: tireDutyMs / G / 1000,
    ...(grip.limitingAxle && cornerLimitedDt > 0
      ? {
          pctFrontLimited: frontLimitedDt / cornerLimitedDt,
          balanceMargin: marginDtSum / cornerLimitedDt,
        }
      : {}),
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
  shiftV: number[],
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
  const { vCorner, aDriveGrip, aBrakeGrip } = grip;

  // Race-pace fraction scales the CORNER ceilings only — the grip-limited
  // stations where an endurance driver actually backs off (cones, tire
  // management, margin). Straights and gearing-capped sections stay flat-out:
  // real endurance drivers still run the straights out, which is why real
  // endurance telemetry reaches top gears (a global speed scale would cap the
  // whole lap at pace×vmax and never leave 4th — the bug Nick spotted).
  //
  // vCorner is a 40-step bisection and the passes below read the ceiling ~5×
  // per cell — but track radii are piecewise-constant (tens of distinct values
  // over ~1000 cells), so solve once per distinct radius and precompute the
  // per-cell ceiling. Identical values, ~6× faster endurance laps.
  // Top-gear limiter speed: past it the engine produces ZERO force (rev cut),
  // so without a cap the forward pass zigzags around it — drag-decelerate one
  // cell (a real −0.4 g!), re-accelerate the next. A real car HOLDS the
  // limiter; cap the envelope there so straights don't grow phantom braking.
  const vLimiter = gearVps(vehicle, vehicle.gearRatios.length - 1) * vehicle.revLimitRpm;
  const vByRadius = new Map<number, number>();
  const ceilArr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const r = radius[i]!;
    let vc = vByRadius.get(r);
    if (vc === undefined) {
      vc = vCorner(r);
      vByRadius.set(r, vc);
    }
    // grip-limited (a true corner ceiling, below the gearing cap) → paced;
    // gearing/aero-capped (straight-line) → flat out (≤ the limiter).
    ceilArr[i] = Math.min(vc < grip.vCap * 0.999 ? pace * vc : vc, vLimiter);
  }
  const ceil = (i: number): number => ceilArr[((i % N) + N) % N]!;

  const vf = new Array<number>(M);
  const vb = new Array<number>(M);

  // Forward pass (acceleration out of corners), GEAR-EXPLICIT with the OPTIMAL
  // shift schedule (tractive-force crossovers — same policy as the accel
  // event): the car uses the gear a force-optimal driver would hold at the
  // entry speed, so the tractive force is that gear's force at its real RPM —
  // NOT the optimistic best-across-gears envelope. This still captures the
  // post-upshift "bog" (the crossover IS where the bog stops costing time) and
  // keeps acceleration honestly gearing-dependent. Drive traction is the rear
  // axle's (weight transfer + rear aero + ellipse), not μ·m·g on all four.
  vf[0] = closed ? ceil(0) : 0;
  for (let i = 1; i < M; i++) {
    const vEntry = Math.min(vf[i - 1]!, ceil(i - 1));
    const gear = gearAtSpeed(shiftV, vEntry);
    const fEng = tractiveForceInGear(curve, vehicle, gear, vEntry);
    const fGrip = m * aDriveGrip(vEntry, rad(i - 1));
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
    const aBrk = aBrakeGrip(vEntry, rad(i + 1));
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
    const gPrev = gearAtSpeed(shiftV, out[i - 1]!);
    const gCur = gearAtSpeed(shiftV, out[i]!);
    if (gCur > gPrev) shiftCount += gCur - gPrev;
  }

  return { v: out, shiftCount };
}
