// Measure the SDM26's performance envelope from the MODEL, not from the spec
// sheet -- and then turn that envelope into a quasi-static lap-time lower
// bound for both courses.
//
//     node sim/tools/car_envelope.mjs [--out DIR] [--quick] [--no-refine]
//                                     [--export-line] [--json]
//
// `--quick` thins every sweep (seconds, not minutes). `--no-refine` skips the
// time-optimising line search, which is most of the runtime. `--export-line`
// additionally writes each line out node by node -- offset and speed at every
// centreline index -- so another tool can read the line rather than just the
// time it produced. The full run takes about six minutes and writes
// out/car_envelope.{json,txt}.
//
// Nothing in here reads a parameter and calls it a capability. Every number
// below is produced by instantiating the same `BicycleModel` + `Powertrain`
// the game drives and asking the car to do something:
//
//   (a) LATERAL   constant-speed steer sweep. The car is respawned at a held
//                 speed, a steer angle is commanded, a speed controller holds
//                 the speed against scrub and drag, and the steady lateral g
//                 is read off the last 0.6 s. The sweep walks the angle up
//                 until the car stops gaining lateral or stops being a car
//                 (body slip runs away / the speed collapses). Which AXLE
//                 saturated first is read from `telemetry.balance`
//                 (load-weighted rear utilisation minus front), so the answer
//                 is the model's own and not an inference from the weight
//                 distribution.
//
//   (b) BRAKING   pedal sweep at a held entry speed, brake bias fixed at
//                 SDM26.brakeBiasFront. Lock is detected from the wheel
//                 STATES -- slip ratio and the wheel-speed-to-road-speed
//                 ratio -- not from a pedal threshold, so "the pedal that
//                 maximises decel without locking" is measured rather than
//                 assumed.
//
//   (c) LONGITUDINAL  full throttle at a held entry speed in each gear, plus
//                 two standing starts (with and without
//                 `Powertrain.setLaunch`) run through the game's own
//                 auto-shift logic, which give 0-60/0-100 km/h, the 75 m
//                 time and the shift points that were actually used.
//
//   (d) COMBINED  at 50% and 80% of the measured lateral limit, how much
//                 accel and how much brake is still there. The exponent of
//                 the best-fit friction ellipse comes out of these points and
//                 is what the lap-time bound uses to blend the two axes.
//
// The lap times are a standard forward/backward-pass quasi-static lap sim run
// on three lines -- the centreline, a minimum-curvature line and a line refined
// for time -- inside a corridor taken from the game's own rules: the wall is
// `Track.locate`'s off-course test (widthAt/2 plus the reach of the tyre
// nearest the course), pinched to the car's width at each boundary CONE, with
// the slalom gates from `Track.checkGates` as hard constraints so a
// straightlined slalom is not available to the optimiser either.
//
// Each line gets two times:
//
//   FLOOR    computed from the car's PEAK TRANSIENT capability on every axis,
//            which is an upper bound on the car and therefore a true LOWER
//            bound on the time. Loose on purpose: no car holds its peak
//            transient lateral and its peak transient accel continuously.
//   SUSTAIN  computed from the steady-state envelope. A realistic target and
//            explicitly NOT a bound -- the human's best archived autocross run
//            beats the steady-envelope pass on its own recorded line.
//
// Both are optimistic in the same ways beyond the envelope: no tyre relaxation
// lag, no yaw inertia, no steering servo, no shift cuts on the
// cornering-limited stretches, and a driver exactly on the friction limit at
// every metre. The run finishes by checking the floor against every real lap in
// the runs archive, because a floor a human has already driven under is not a
// floor -- it is a number that will quietly certify a broken lap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SDM26 } from "../src/vehicle/params.js";
import { Powertrain } from "../src/vehicle/powertrain.js";
import { BicycleModel } from "../src/vehicle/bicycle.js";
import { Track } from "../src/track/track.js";
import { bodyBoxFor } from "../src/render/carmesh.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const G = 9.81;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QUICK = flag("quick");
const NO_REFINE = flag("no-refine");
const OUT = arg("out", path.join(HERE, "out"));

/** Where the game writes runs. Same resolution `make_sample_run.mjs` uses. */
function runsDir() {
  if (process.env.FSAE_SIM_RUNS_DIR) return process.env.FSAE_SIM_RUNS_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Helios", "sim-runs");
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME ?? "", "Library", "Application Support", "Helios", "sim-runs");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME ?? "", ".local", "share"),
    "Helios", "sim-runs");
}

/**
 * Every real, human-driven, valid lap in the archive, by course.
 *
 * This is the only external check there is on a lap-time floor, and it is a
 * good one: a floor that a lap somebody has actually driven gets under is
 * simply wrong, and the wrongness is invisible unless you look. Synthetic runs
 * are excluded -- a robot lap is not evidence about the car -- and so are
 * invalid laps.
 */
function archivedLaps() {
  const out = {};
  let dir;
  try { dir = runsDir(); if (!fs.existsSync(dir)) return out; } catch { return out; }
  for (const id of fs.readdirSync(dir)) {
    const mf = path.join(dir, id, "run.json");
    if (!fs.existsSync(mf)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch { continue; }
    if (m.synthetic) continue;
    const course = m.track;
    if (course !== "autocross" && course !== "endurance") continue;
    for (const lap of m.laps ?? []) {
      if (lap.valid === false || lap.raw == null) continue;
      (out[course] ??= []).push({
        runId: id, driver: m.driver ?? null, lap: lap.lap,
        rawS: lap.raw, totalS: lap.total, cones: lap.cones,
        physics: m.physics ?? null, flying: !!m.trackClosed && lap.lap > 1,
      });
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.rawS - b.rawS);
  return out;
}

// Helios finding 0039: --curve FILE swaps in an alternative torque curve (same schema as data/sdm26-torque.json).
const CURVE = JSON.parse(fs.readFileSync(arg("curve", path.join(DATA, "sdm26-torque.json")), "utf8"));

const DT = 1 / 500; // the model's own substep, so nothing is aliased

// ----------------------------------------------------------------- rig ----

/** A fresh car + powertrain. Nothing is shared between trials. */
function rig() {
  const pt = new Powertrain(SDM26, CURVE);
  const car = new BicycleModel(SDM26, pt);
  return { car, pt };
}

/** Engine rpm gear `g` (0-based) would show at road speed `v`. */
const rpmIn = (g, v) =>
  (v / SDM26.tireRadiusM) *
  (SDM26.primaryReduction * SDM26.gearRatios[g] * SDM26.finalDrive) *
  (60 / (2 * Math.PI));

/**
 * The gear to hold a steady speed in: the tallest one that still has the
 * engine above 5000 rpm, else the shortest that is not on the limiter. This is
 * a test-rig choice and it is recorded with every result, because a gear
 * choice is an engine-braking choice and engine braking is a longitudinal
 * force.
 */
function cruiseGear(v) {
  const top = SDM26.gearRatios.length - 1;
  for (let g = top; g >= 0; g--) {
    const r = rpmIn(g, v);
    if (r >= 5000 && r <= SDM26.revLimitRpm - 300) return g;
  }
  for (let g = 0; g <= top; g++) if (rpmIn(g, v) <= SDM26.revLimitRpm - 300) return g;
  return top;
}

/** Place the car at `v` m/s, straight, in gear `g`, crank synced to the wheel. */
function place(v, g = cruiseGear(v)) {
  const r = rig();
  r.pt.gear = g;
  r.car.respawn(0, 0, 0, v);
  return r;
}

/** The game's own auto-shift, lifted from `main.js` / `make_sample_run.mjs`. */
function autoShift(pt, car) {
  if (!pt.canShift()) return;
  if (pt.engineRpm > pt.optimalUpshiftRpm()) pt.requestUpshift();
  else if (pt.gear > 0 && pt.engineRpm < 5200 && pt.downshiftSafe(car.wR)) pt.requestDownshift();
}

/** Wheel-speed-to-road-speed ratios and slip ratios, for lock detection. */
function wheelSlipState(car) {
  const R = SDM26.tireRadiusM;
  const v = Math.max(car.speed, 0.5);
  return {
    front: (car.wF * R) / v,
    rear: (car.wR * R) / v,
    kappaF: car.telemetry.kappaF,
    kappaR: car.telemetry.kappaR,
  };
}

// ------------------------------------------- (a) steady-state lateral -----

/**
 * One constant-speed, constant-steer trial.
 * @returns the steady state it settled into, and whether that was a steady
 *          state at all.
 */
function lateralTrial(v, steerDeg, holdS = 3.2) {
  const { car, pt } = place(v);
  const steer = steerDeg / SDM26.maxSteerDeg;
  const n = Math.round(holdS / DT);
  const tail = Math.round(0.6 / DT);
  // The first second is the steer servo, the relaxation length and the speed
  // controller's integrator all settling. Judging stability on it rejected
  // every SMALL-angle trial at low speed -- the transient overshoot is a
  // large multiple of a tiny steady value -- and that killed the whole sweep
  // before it reached the limit.
  const settle = Math.round(1.0 / DT);
  let sumAy = 0, sumUtilF = 0, sumUtilR = 0, sumBal = 0, sumThr = 0, sumSpeed = 0, sumSlip = 0, m = 0;
  let sumYaw = 0;
  let peakAy = 0, maxSlip = 0, minSpeed = v;
  let integral = 0;
  for (let i = 0; i < n; i++) {
    // Speed hold: PI on the throttle, a little brake if it runs away. A real
    // skidpad is driven on the throttle too, so the grip that spends is part
    // of the measurement rather than an artefact of it.
    const err = v - car.speed;
    integral = clamp(integral + err * DT * 0.6, -1, 1);
    const throttle = clamp(0.35 * err + integral, 0, 1);
    const brake = clamp(-0.25 * err, 0, 0.4);
    autoShift(pt, car);
    car.step(DT, { steer, throttle, brake });
    const t = car.telemetry;
    const slip = Math.abs(t.bodySlipDeg);
    if (i >= settle) {
      peakAy = Math.max(peakAy, Math.abs(t.ayG));
      maxSlip = Math.max(maxSlip, slip);
      minSpeed = Math.min(minSpeed, car.speed);
    }
    if (i >= n - tail) {
      sumAy += Math.abs(t.ayG); sumUtilF += t.utilF; sumUtilR += t.utilR;
      sumBal += t.balance; sumThr += throttle; sumSpeed += car.speed; sumSlip += slip;
      sumYaw += (Math.abs(t.yawRateDegS) * Math.PI) / 180 * car.speed / G;
      m++;
    }
    if (!Number.isFinite(car.X) || !Number.isFinite(car.speed)) break;
  }
  const steadyAy = m ? sumAy / m : 0;
  const speedHeld = m ? sumSpeed / m : 0;
  // What makes a trial a STEADY STATE and not a spin: the car still points
  // roughly where it is going, it did not lose the speed it was asked to
  // hold, and the lateral g at the end is still near the peak it reached -- a
  // car that has departed peaks on the way out and then falls off.
  // A steady state is a CIRCLE: the yaw rate and the lateral acceleration
  // have to agree, ay = r V. In a departure they do not -- the car keeps
  // yawing while the lateral force falls away -- and that test works at every
  // speed, where an absolute body-slip limit does not: a 3 m radius at 5 m/s
  // legitimately runs far more slip than a 30 m radius at 25 m/s, and a fixed
  // 12 deg ceiling threw away the whole bottom of the speed range.
  const ayFromYaw = m ? sumYaw / m : 0;
  const circular = steadyAy > 0.02 ? Math.abs(ayFromYaw - steadyAy) < 0.3 * steadyAy : true;
  const stable = m > 0 && maxSlip < 35 && circular &&
    speedHeld > v * 0.85 && steadyAy > 0.85 * peakAy;
  return {
    steerDeg, steadyAyG: steadyAy, peakAyG: peakAy,
    utilF: m ? sumUtilF / m : 0, utilR: m ? sumUtilR / m : 0, balance: m ? sumBal / m : 0,
    throttle: m ? sumThr / m : 0, bodySlipDeg: m ? sumSlip / m : 0,
    maxBodySlipDeg: maxSlip, speedHeldMps: speedHeld, minSpeedMps: minSpeed, stable,
  };
}

function measureLateral(speeds) {
  const rows = [];
  for (const v of speeds) {
    // Coarse walk up, then a fine pass around the coarse peak. The walk stops
    // three steps past the best it has seen, or as soon as the car departs
    // twice running: past that the trials are spins, not data.
    const coarse = [];
    let bad = 0, bestI = -1;
    for (let d = 1; d <= SDM26.maxSteerDeg; d += 1) {
      const t = lateralTrial(v, d);
      coarse.push(t);
      if (t.stable && (bestI < 0 || t.steadyAyG > coarse[bestI].steadyAyG)) bestI = coarse.length - 1;
      if (!t.stable) { if (++bad >= 2) break; } else bad = 0;
      if (bestI >= 0 && coarse.length - bestI > 3) break;
    }
    if (bestI < 0) { rows.push({ speedMps: v, error: "never reached a steady state" }); continue; }
    const d0 = coarse[bestI].steerDeg;
    let best = coarse[bestI];
    for (let d = Math.max(0.25, d0 - 1); d <= d0 + 1.001; d += 0.25) {
      const t = lateralTrial(v, Math.round(d * 100) / 100, 4.0);
      if (t.stable && t.steadyAyG > best.steadyAyG) best = t;
    }
    // Which end let go first: walk the sweep from zero and find the first
    // trial where either axle's utilisation passed 1.0.
    let firstSat = null;
    for (const t of coarse) {
      if (t.utilF >= 1 || t.utilR >= 1) {
        firstSat = {
          steerDeg: t.steerDeg,
          axle: t.utilF >= t.utilR ? "front" : "rear",
          utilF: r3(t.utilF), utilR: r3(t.utilR),
        };
        break;
      }
    }
    rows.push({
      speedMps: v, speedKph: r2(v * 3.6),
      gear: cruiseGear(v) + 1,
      maxLatG: r3(best.steadyAyG),
      atSteerDeg: best.steerDeg,
      radiusM: r2((best.speedHeldMps ** 2) / Math.max(best.steadyAyG * G, 1e-6)),
      utilF: r3(best.utilF), utilR: r3(best.utilR), balance: r3(best.balance),
      limitingAxle: best.balance < 0 ? "front" : "rear",
      throttleToHold: r3(best.throttle),
      bodySlipDeg: r2(best.bodySlipDeg),
      firstSaturated: firstSat,
      departedAboveDeg: coarse.find((t) => !t.stable)?.steerDeg ?? null,
    });
  }
  return rows;
}

/**
 * The PEAK lateral g the car can be made to produce at a speed -- a step
 * steer, read over the first second, before the load transfer has settled.
 *
 * This is deliberately a different question from the steady-state one above,
 * and both answers are needed. A steady state is what the car will hold round
 * a constant-radius corner; the transient peak is what it will give a driver
 * for the moment of a direction change, and on a 685 m autocross with two
 * slaloms that moment is most of the lap. The human's best archived run peaks
 * at 1.84 g, which is above the steady-state number at every speed it reached
 * -- so a lap-time bound built on the steady-state figure alone is not a
 * bound, and this run proves it by beating it. The bound uses whichever of
 * the two is larger, which keeps it a bound.
 *
 * A peak reached while the car is already past 20 deg of body slip is not
 * counted: that is a spin, and the lateral force in it is not available to a
 * driver who intends to still be on the course afterwards.
 */
function transientLateral(speeds) {
  const rows = [];
  for (const v of speeds) {
    let best = { peakAyG: 0, steerDeg: 0, slipAtPeakDeg: 0 };
    for (let d = 1; d <= SDM26.maxSteerDeg; d += 1) {
      const { car, pt } = place(v);
      const steer = d / SDM26.maxSteerDeg;
      let integral = 0, peak = 0, slipAt = 0;
      for (let i = 0; i < Math.round(1.0 / DT); i++) {
        const err = v - car.speed;
        integral = clamp(integral + err * DT * 0.6, -1, 1);
        autoShift(pt, car);
        car.step(DT, {
          steer,
          throttle: clamp(0.35 * err + integral, 0, 1),
          brake: clamp(-0.25 * err, 0, 0.4),
        });
        const t = car.telemetry;
        const slip = Math.abs(t.bodySlipDeg);
        if (slip < 20 && Math.abs(t.ayG) > peak) { peak = Math.abs(t.ayG); slipAt = slip; }
      }
      if (peak > best.peakAyG) best = { peakAyG: peak, steerDeg: d, slipAtPeakDeg: slipAt };
    }
    rows.push({
      speedMps: v, speedKph: r2(v * 3.6),
      peakLatG: r3(best.peakAyG),
      atSteerDeg: best.steerDeg,
      bodySlipAtPeakDeg: r2(best.slipAtPeakDeg),
    });
  }
  return rows;
}

// ------------------------------------------------------------ (b) braking --

function brakeTrial(v, pedal) {
  const { car, pt } = place(v);
  // The decel is measured over a speed WINDOW that starts a little below the
  // entry speed, so the pedal has settled and the load has transferred by the
  // time the clock starts.
  const hi = v - 0.5;
  const lo = Math.max(1.5, v - 3.0);
  let t = 0, tHi = null, tLo = null;
  let locked = false, lockedWhere = null, minRatioF = 9, minRatioR = 9;
  let sumAx = 0, mAx = 0;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    autoShift(pt, car);
    car.step(DT, { steer: 0, throttle: 0, brake: pedal });
    t += DT;
    const s = wheelSlipState(car);
    if (car.speed > lo) {
      minRatioF = Math.min(minRatioF, s.front);
      minRatioR = Math.min(minRatioR, s.rear);
      // A locked wheel: turning well slower than the road, or a slip ratio
      // clearly past the far side of the Fx peak (which is 0.11).
      if (s.front < 0.85 || s.kappaF < -0.22) { locked = true; lockedWhere = lockedWhere ?? "front"; }
      if (s.rear < 0.85 || s.kappaR < -0.22) { locked = true; lockedWhere = lockedWhere ?? "rear"; }
    }
    if (tHi == null && car.speed <= hi) tHi = t;
    if (tHi != null && car.speed > lo) { sumAx += -car.telemetry.axG; mAx++; }
    if (tHi != null && tLo == null && car.speed <= lo) { tLo = t; break; }
    if (car.speed < 0.3) { tLo = t; break; }
  }
  const meanG = tHi != null && tLo != null && tLo > tHi ? (hi - lo) / (tLo - tHi) / G : 0;
  return {
    pedal, meanDecelG: meanG, sampledDecelG: mAx ? sumAx / mAx : 0,
    locked, lockedWhere, minWheelRatioF: r3(minRatioF), minWheelRatioR: r3(minRatioR),
  };
}

function measureBraking(speeds) {
  const rows = [];
  for (const v of speeds) {
    const trials = [];
    for (let p = 0.10; p <= 1.0001; p += 0.02) trials.push(brakeTrial(v, Math.round(p * 100) / 100));
    const clean = trials.filter((t) => !t.locked);
    const best = clean.reduce((b, t) => (b == null || t.meanDecelG > b.meanDecelG ? t : b), null);
    const anyBest = trials.reduce((b, t) => (b == null || t.meanDecelG > b.meanDecelG ? t : b), null);
    const firstLock = trials.find((t) => t.locked);
    const full = trials[trials.length - 1];
    rows.push({
      speedMps: v, speedKph: r2(v * 3.6),
      bestPedal: best ? best.pedal : null,
      maxBrakeG: best ? r3(best.meanDecelG) : null,
      lockThresholdPedal: firstLock ? firstLock.pedal : null,
      locksFirst: firstLock ? firstLock.lockedWhere : null,
      // What a locked wheel actually costs, so "threshold braking is a skill"
      // is a measured statement and not a slogan.
      fullPedalG: r3(full.meanDecelG),
      fullPedalLocked: full.locked,
      bestIgnoringLock: anyBest ? r3(anyBest.meanDecelG) : null,
      brakeBiasFront: SDM26.brakeBiasFront,
    });
  }
  return rows;
}

// ------------------------------------------------------- (c) longitudinal --

/** Full throttle at a held entry speed in one gear: the accel available there. */
function accelAt(v, g) {
  const { car, pt } = place(v, g);
  let sum = 0, m = 0, maxKappa = 0;
  const settle = Math.round(0.15 / DT), win = Math.round(0.25 / DT);
  for (let i = 0; i < settle + win; i++) {
    car.step(DT, { steer: 0, throttle: 1, brake: 0 });
    if (i >= settle) { sum += car.telemetry.axG; m++; maxKappa = Math.max(maxKappa, car.telemetry.kappaR); }
  }
  return { axG: m ? sum / m : 0, maxKappaRear: maxKappa, rpm: pt.engineRpm };
}

function measureAccel(speeds) {
  const rows = [];
  for (const v of speeds) {
    const perGear = [];
    for (let g = 0; g < SDM26.gearRatios.length; g++) {
      const rpm = rpmIn(g, v);
      if (rpm > SDM26.revLimitRpm - 100) {
        perGear.push({ gear: g + 1, rpm: r0(rpm), axG: null, note: "over the limiter" });
        continue;
      }
      const a = accelAt(v, g);
      perGear.push({ gear: g + 1, rpm: r0(a.rpm), axG: r3(a.axG), kappaRear: r3(a.maxKappaRear) });
    }
    const usable = perGear.filter((p) => p.axG != null);
    const best = usable.reduce((b, p) => (b == null || p.axG > b.axG ? p : b), null);
    // Traction-limited or power-limited? A slip ratio at or past the tyre's
    // own Fx peak (0.11) says the tyre is the limit, not the engine.
    rows.push({
      speedMps: v, speedKph: r2(v * 3.6),
      maxAccelG: best ? best.axG : null,
      inGear: best ? best.gear : null,
      limit: best && best.kappaRear >= 0.10 ? "traction" : "power",
      perGear,
    });
  }
  return rows;
}

/**
 * The PEAK longitudinal g available at each speed, from a full-throttle run.
 *
 * The per-gear numbers above are steady values: the crank is synced to the
 * wheel, the driveline has no energy stored in it, and the tyre sits at
 * whatever slip ratio the engine's torque asks for -- at 15 m/s that is 0.05,
 * half of the tyre's own Fx peak. A car that has just upshifted is not in that
 * state. Its crank is above synchronous, the driveline is giving energy BACK,
 * and the rear tyre is at or near its peak slip ratio: the human's best
 * archived run shows 2823 N of rear Fx and 0.96 g at 15.3 m/s in second,
 * where the steady figure for that gear and speed is 2229 N and 0.73 g.
 *
 * A lap-time LOWER bound has to use an UPPER bound on capability, so it uses
 * this table and not the steady one. It is loose on purpose: no car holds its
 * peak transient accel continuously. That is exactly what makes the result a
 * floor rather than a target.
 */
function accelEnvelopeSweep(bin = 1) {
  const peak = new Map();
  const note = (v, g) => {
    const b = Math.round(v / bin) * bin;
    if (!(peak.get(b) >= g)) peak.set(b, g);
  };
  // Two runs -- plain and launch-controlled -- plus one per gear held from
  // low speed to the limiter, which is where the post-shift state lives.
  for (const useLaunch of [false, true]) {
    const { car, pt } = rig();
    car.respawn(0, 0, 0, 0);
    if (useLaunch) {
      pt.setLaunch(true);
      for (let i = 0; i < Math.round(1.2 / DT); i++) car.step(DT, { steer: 0, throttle: 1, brake: 1 });
      pt.setLaunch(false);
    }
    for (let i = 0; i < Math.round(20 / DT); i++) {
      autoShift(pt, car);
      car.step(DT, { steer: 0, throttle: 1, brake: 0 });
      note(car.speed, car.telemetry.axG);
      if (car.speed > 34) break;
    }
  }
  for (let g = 0; g < SDM26.gearRatios.length; g++) {
    const vStart = Math.max(1, (SDM26.idleRpm / rpmIn(g, 1)) * 1);
    const { car, pt } = place(vStart, g);
    for (let i = 0; i < Math.round(20 / DT); i++) {
      car.step(DT, { steer: 0, throttle: 1, brake: 0 });
      note(car.speed, car.telemetry.axG);
      if (rpmIn(g, car.speed) > SDM26.revLimitRpm || car.speed > 34) break;
    }
  }
  return [...peak.keys()].sort((a, b) => a - b)
    .map((v) => ({ speedMps: v, speedKph: r2(v * 3.6), peakAccelG: r3(peak.get(v)) }));
}

/** A standing start through the auto-shift, with or without launch control. */
function standingStart(useLaunch, distanceM = 90) {
  const { car, pt } = rig();
  car.respawn(0, 0, 0, 0);
  const marks = {};
  const shifts = [];
  let t = 0, dist = 0, launchS = 0;
  if (useLaunch) {
    // Hold the engine on the LC limiter on the brake, then dump the clutch.
    // 1.2 s is long enough for it to settle there and bounce.
    pt.setLaunch(true);
    for (let i = 0; i < Math.round(1.2 / DT); i++) {
      car.step(DT, { steer: 0, throttle: 1, brake: 1 });
      launchS += DT;
    }
    pt.setLaunch(false);
  }
  let lastGear = pt.gear;
  let peakG = 0;
  for (let i = 0; i < Math.round(15 / DT); i++) {
    autoShift(pt, car);
    car.step(DT, { steer: 0, throttle: 1, brake: 0 });
    t += DT;
    dist += car.speed * DT;
    peakG = Math.max(peakG, car.telemetry.axG);
    if (pt.gear !== lastGear) {
      shifts.push({ to: pt.gear + 1, atS: r3(t), atKph: r2(car.speed * 3.6), rpm: r0(pt.engineRpm) });
      lastGear = pt.gear;
    }
    for (const kph of [30, 60, 100]) {
      const k = `to${kph}`;
      if (marks[k] == null && car.speed * 3.6 >= kph) marks[k] = r3(t);
    }
    for (const d of [75, 90]) {
      const k = `at${d}`;
      if (marks[k] == null && dist >= d) marks[k] = { s: r3(t), kph: r2(car.speed * 3.6) };
    }
    if (dist >= distanceM) break;
  }
  return {
    launch: useLaunch, launchHoldS: r2(launchS),
    to30KphS: marks.to30 ?? null, to60KphS: marks.to60 ?? null, to100KphS: marks.to100 ?? null,
    accel75mS: marks.at75?.s ?? null, kphAt75m: marks.at75?.kph ?? null,
    accel90mS: marks.at90?.s ?? null,
    peakAccelG: r3(peakG), shifts,
  };
}

// ----------------------------------------------------------- (d) combined --

/**
 * At a held speed and a lateral load of `latTargetG`, what is left
 * longitudinally. The steer angle is SEARCHED for rather than assumed: the
 * relationship between angle and lateral g is not linear near the limit.
 */
function combinedAt(v, latTargetG, mode) {
  let lo = 0.1, hi = SDM26.maxSteerDeg, steerDeg = 1;
  for (let i = 0; i < 16; i++) {
    steerDeg = 0.5 * (lo + hi);
    const t = lateralTrial(v, steerDeg, 2.4);
    if (!t.stable || t.steadyAyG > latTargetG) hi = steerDeg; else lo = steerDeg;
  }
  steerDeg = lo;
  // Now: establish the cornering steady state at the held speed FIRST, then
  // put the pedal down and read the next 0.35 s.
  //
  // Measuring over the tail of a longer window does not work for the brake
  // half: braking sheds speed, `ay = v^2/R` falls with it, and the trial then
  // fails its own "is it still holding the lateral load" test. Every brake
  // point came back "no stable point" for exactly that reason. A short window
  // straight after the pedal goes down is also what a driver is actually
  // asking of the car at a corner entry.
  let best = null;
  const steer = steerDeg / SDM26.maxSteerDeg;
  for (let pedal = 0.05; pedal <= 1.0001; pedal += 0.05) {
    const { car, pt } = place(v);
    let integral = 0;
    for (let i = 0; i < Math.round(2.5 / DT); i++) {
      const err = v - car.speed;
      integral = clamp(integral + err * DT * 0.6, -1, 1);
      autoShift(pt, car);
      car.step(DT, { steer, throttle: clamp(0.35 * err + integral, 0, 1), brake: clamp(-0.25 * err, 0, 0.4) });
    }
    const ay0 = Math.abs(car.telemetry.ayG);
    if (ay0 < latTargetG * 0.7) continue; // the corner was never established
    const win = Math.round(0.35 / DT), skip = Math.round(0.08 / DT);
    let sumAx = 0, sumAy = 0, m = 0, maxSlip = 0;
    for (let i = 0; i < win; i++) {
      if (mode === "accel") autoShift(pt, car);
      car.step(DT, {
        steer,
        throttle: mode === "accel" ? pedal : 0,
        brake: mode === "brake" ? pedal : 0,
      });
      maxSlip = Math.max(maxSlip, Math.abs(car.telemetry.bodySlipDeg));
      if (i >= skip) { sumAx += car.telemetry.axG; sumAy += Math.abs(car.telemetry.ayG); m++; }
    }
    const ax = m ? sumAx / m : 0, ay = m ? sumAy / m : 0;
    // The car must still be turning as hard as it was asked to and must not
    // be departing. 0.85 of the target, because shedding or gaining speed
    // over a third of a second moves `v^2/R` a little whatever happens.
    const ok = maxSlip < 14 && ay > latTargetG * 0.85;
    const score = mode === "accel" ? ax : -ax;
    if (ok && (best == null || score > best.score)) {
      best = { pedal: r2(pedal), axG: r3(ax), ayG: r3(ay), score, maxBodySlipDeg: r2(maxSlip) };
    }
  }
  return best
    ? { steerDeg: r2(steerDeg), pedal: best.pedal, axG: best.axG, ayG: best.ayG }
    : { steerDeg: r2(steerDeg), axG: null, error: "no stable point" };
}

function measureCombined(lateral, speeds, fracs = [0.5, 0.8]) {
  const out = [];
  for (const v of speeds) {
    const lat = lateral.find((l) => l.speedMps === v);
    if (!lat || lat.maxLatG == null) continue;
    for (const f of fracs) {
      const target = lat.maxLatG * f;
      out.push({
        speedMps: v, latFrac: f, latTargetG: r3(target),
        accel: combinedAt(v, target, "accel"),
        brake: combinedAt(v, target, "brake"),
      });
    }
  }
  return out;
}

/**
 * Fit the friction-ellipse exponent p in (ax/axMax)^p + (ay/ayMax)^p = 1 to
 * the combined points, so the lap-time bound blends the two axes the way the
 * model actually does rather than on a circle by assumption.
 */
function fitEllipse(combined, lateral, accel, braking) {
  const samples = [];
  for (const c of combined) {
    const lat = lateral.find((l) => l.speedMps === c.speedMps);
    const acc = accel.find((a) => a.speedMps === c.speedMps);
    const brk = braking.find((b) => b.speedMps === c.speedMps);
    if (!lat) continue;
    for (const [mode, ref] of [["accel", acc?.maxAccelG], ["brake", brk?.maxBrakeG]]) {
      const pt = c[mode];
      if (!pt || pt.axG == null || !ref) continue;
      const ny = Math.min(1, Math.abs(pt.ayG) / lat.maxLatG);
      const nx = Math.min(1, Math.abs(pt.axG) / ref);
      if (nx < 0.02 || ny < 0.02 || ny > 0.995) continue;
      samples.push({ nx: r3(nx), ny: r3(ny), mode, speedMps: c.speedMps });
    }
  }
  let bestP = 2, bestErr = Infinity;
  for (let p = 1.2; p <= 4.001; p += 0.02) {
    let e = 0;
    for (const s of samples) e += (s.nx ** p + s.ny ** p - 1) ** 2;
    if (e < bestErr) { bestErr = e; bestP = p; }
  }
  return {
    exponent: samples.length ? r2(bestP) : 2,
    rms: samples.length ? r3(Math.sqrt(bestErr / samples.length)) : null,
    samples: samples.length,
    points: samples,
  };
}

// ----------------------------------------- the envelope, as functions -----

function lerpTable(rows, xKey, yKey) {
  const pts = rows.filter((r) => r[yKey] != null)
    .map((r) => [r[xKey], r[yKey]])
    .sort((a, b) => a[0] - b[0]);
  return (x) => {
    if (!pts.length) return 0;
    if (x <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return last[1];
  };
}

// ------------------------------------------------ the quasi-static bound --

/**
 * A driving line inside the corridor.
 *
 * The centreline is the trivial one -- except that it still has to weave the
 * slaloms, whose cones sit ON the centreline. The optimised one minimises
 * curvature energy, sum |p[i-1] - 2 p[i] + p[i+1]|^2, by projected gradient
 * descent on the lateral offset of each point. The corridor is the local
 * course width from `Track.widthAt` minus the car's own half width, so the
 * whole car stays between the cones, and each slalom cone adds a hard
 * one-sided constraint from its own gate so a straightlined slalom is not
 * available to the optimiser either.
 */
/**
 * Every cone the real body box hits when it is swept along `off`.
 *
 * This is the check the corridor arithmetic cannot do for itself. The corridor
 * is a MODEL of the rules -- a wall per node, a pinch per cone, a side per gate
 * -- and a model of a rectangle-versus-circle test is not that test. Sweeping
 * the actual `bodyBoxFor(SDM26)` along the line at the line's own heading and
 * calling the game's own `Track.strikeCones` is.
 *
 * It was not here to begin with, and it should have been: every line this file
 * produced knocked cones over. The autocross time-optimised line hit 12, the
 * endurance one 19, and the CENTRELINE hit 18 -- so the floors this file
 * published (37.9 s and 220.5 s) were floors for a lap that would have scored
 * 24 s and 38 s of cone penalty. A lap-time floor computed on a line that is
 * not clean is not a floor for a clean lap, which is the only kind that counts.
 *
 * The cause was the gate constraint: a slalom cone got its clearance at ONE
 * node, while the car is 2.58 m long and sweeps past the cone for a metre and a
 * half either side, so the line was free to spike out at the cone's own node
 * and come back, and the body clipped it on the way in. Boundary cones had the
 * same bug one node wider.
 */
function sweepStrikes(track, off, step = 0.25) {
  const n = track.center.length;
  const box = bodyBoxFor(SDM26);
  const closed = !!track.closed;
  const P = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = track.heading[i];
    P[i] = [track.center[i][0] - Math.sin(h) * off[i], track.center[i][1] + Math.cos(h) * off[i]];
  }
  const at = (i) => P[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  track.resetCones();
  track.resetGates();
  track.lastIndex = 0;
  const struck = new Set();
  let missedGates = 0, offSamples = 0;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = at(i), b = at(i + 1);
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / step));
    const psi = Math.atan2(at(i + 1)[1] - at(i - 1)[1], at(i + 1)[0] - at(i - 1)[0]);
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      const pose = { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, psi };
      if (track.strikeCones(pose, box) > 0) {
        // `strikeCones` returns a count, not an identity; the cones it just
        // flattened are the ones near the car that are now down.
        for (const c of track.conesNear(pose.x, pose.y, 6)) {
          if (c.down && !c.pointer) struck.add(c);
        }
      }
      missedGates += track.checkGates(pose).length;
      if (!track.locate(pose.x, pose.y, psi).onTrack) offSamples++;
    }
  }
  track.resetCones();
  track.resetGates();
  track.lastIndex = 0;
  return { struck: [...struck], missedGates, offSamples };
}

function buildLine(track, { optimise, sweeps = 30000, repairRounds = 8 } = {}) {
  const n = track.center.length;
  const half = bodyBoxFor(SDM26).halfWidth;
  const CONE_R = 0.155;

  // ---- the corridor, as the GAME defines it, not as it looks on a map ----
  //
  // Two separate constraints, and getting them confused is what made the
  // first version of this bound slower than a lap the human had actually
  // driven:
  //
  //   1. OFF COURSE is `Track.locate`: |lateral| > widthAt(i)/2 + the reach
  //      of the tyre nearest the course, which is the body box's own half
  //      width. That is the hard wall. On autocross it is +-2.45 m for the
  //      CG, not +-1.05 m.
  //
  //   2. CONES are DISCRETE. There are 96 boundary cones a side over 685 m --
  //      one every 7 m -- so the line is only pinched to the width of the car
  //      WHERE A CONE IS. Between them the whole corridor is available, and
  //      the human's best archived run uses it: its peak lateral error is
  //      1.295 m, which is well outside a cone-to-cone corridor and touched
  //      nothing.
  //
  // So: the wall is the off-course boundary, with a pinch at each cone.
  const wall = new Float64Array(n);
  for (let i = 0; i < n; i++) wall[i] = track.widthAt(i) / 2 + half;

  const idxOf = (i) => (track.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const latOf = (i, x, y) => {
    const h = track.heading[i], p = track.center[i];
    return -Math.sin(h) * (x - p[0]) + Math.cos(h) * (y - p[1]);
  };

  // Where each cone sits, once. `nearestIndex` walks a spatial hash and is not
  // free, and the repair loop rebuilds the bounds several times.
  const placed = [];
  for (const cone of track.cones) {
    if (cone.pointer) continue; // lies there by design; a strike never counts it
    const { index } = track.nearestIndex(cone.x, cone.y);
    placed.push({ cone, index, lat: latOf(index, cone.x, cone.y) });
  }
  track.lastIndex = 0; // leave the track's nearest-point cache where it began

  /**
   * How far either side of its own node each cone's clearance reaches, and how
   * much clearance it asks for.
   *
   * Both start small -- one node, 3 cm of slack -- because cones are DISCRETE
   * and pinching the whole corridor at every one of them would throw away most
   * of the width the course actually has. The repair loop below raises them for
   * the cones the swept body genuinely hits, and only those. That keeps the
   * discreteness where it is real and pays for width only where the geometry
   * says it must.
   */
  const span = new Map(placed.map((p) => [p.cone, 1]));
  const extra = new Map(placed.map((p) => [p.cone, 0]));

  let lo = new Float64Array(n), hi = new Float64Array(n);
  let conePinches = 0, gateCount = 0;
  const buildBounds = () => {
    lo = new Float64Array(n); hi = new Float64Array(n);
    for (let i = 0; i < n; i++) { lo[i] = -wall[i]; hi[i] = wall[i]; }
    conePinches = 0; gateCount = 0;
    for (const { cone, index, lat } of placed) {
      const clear = half + CONE_R + 0.03 + extra.get(cone);
      const sp = span.get(cone);
      // A slalom cone sits ON the centreline and must be passed on the side its
      // gate names; `pass` +1 is left of the slalom's line. A boundary cone
      // just has to be missed, on whichever side of the course it is on.
      const wantLeft = cone.gate ? cone.gate.pass > 0 : lat < 0;
      for (let k = -sp; k <= sp; k++) {
        const j = idxOf(index + k);
        if (wantLeft) lo[j] = Math.max(lo[j], Math.min(lat + clear, wall[j]));
        else hi[j] = Math.min(hi[j], Math.max(lat - clear, -wall[j]));
      }
      if (cone.gate) gateCount++; else conePinches++;
    }
    for (let i = 0; i < n; i++) {
      if (lo[i] > hi[i]) { const mid = 0.5 * (lo[i] + hi[i]); lo[i] = hi[i] = mid; }
    }
  };
  buildBounds();

  const off = new Float64Array(n);
  const solve = (nSweeps, reseed) => {
  if (reseed) for (let i = 0; i < n; i++) off[i] = clamp(0, lo[i], hi[i]); // the weave, always
  else for (let i = 0; i < n; i++) off[i] = clamp(off[i], lo[i], hi[i]);
  if (optimise) {
    const sweeps = nSweeps;
    // Minimum curvature energy, sum |p[j-1] - 2 p[j] + p[j+1]|^2, by
    // COORDINATE minimisation with the constraints as a projection.
    //
    // Gauss-Seidel, not Jacobi, and the exact one-variable minimum rather
    // than a small gradient step: d2E/dn^2 is 2*(1 + 4 + 1) = 12 for every
    // node, so the exact step is -dE/dn / 12 and the sweep uses neighbours
    // already updated this pass. The first version of this was Jacobi
    // gradient descent at a step of 0.06, which is stable but propagates
    // information one node per iteration -- on a 686-node course the
    // long-wavelength part of the answer had not moved at all after 3000
    // iterations, and the "optimised" line was barely better than the
    // centreline.
    const px = new Float64Array(n), py = new Float64Array(n);
    const nx = new Float64Array(n), ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = track.heading[i];
      nx[i] = -Math.sin(h); ny[i] = Math.cos(h);
      px[i] = track.center[i][0] + nx[i] * off[i];
      py[i] = track.center[i][1] + ny[i] * off[i];
    }
    for (let it = 0; it < sweeps; it++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        if (!track.closed && (i === 0 || i === n - 1)) continue;
        let g = 0;
        for (const [j, w] of [[i - 1, 1], [i, -2], [i + 1, 1]]) {
          if (!track.closed && (j <= 0 || j >= n - 1)) continue;
          const a = idxOf(j - 1), b = idxOf(j), c = idxOf(j + 1);
          const dx = px[a] - 2 * px[b] + px[c];
          const dy = py[a] - 2 * py[b] + py[c];
          g += 2 * w * (dx * nx[i] + dy * ny[i]);
        }
        const next = clamp(off[i] - g / 12, lo[i], hi[i]);
        moved = Math.max(moved, Math.abs(next - off[i]));
        off[i] = next;
        px[i] = track.center[i][0] + nx[i] * next;
        py[i] = track.center[i][1] + ny[i] * next;
      }
      if (moved < 1e-7) break;
    }
  }
  };
  solve(sweeps, true);

  // ---- repair: make the line legal against the REAL cone test --------------
  //
  // The corridor above is a model and the sweep is the truth, so the sweep gets
  // the last word. Any cone the swept body actually hits has its clearance
  // raised and its reach widened by one node, the bounds are rebuilt, and the
  // line is re-solved from where it already is. Only the offending cones pay,
  // which is what keeps the discreteness of the cone line worth having: on
  // endurance this ends up touching a few dozen cones out of 604.
  let repair = { struck: [], missedGates: 0, offSamples: 0 };
  let rounds = 0;
  for (; rounds < repairRounds; rounds++) {
    repair = sweepStrikes(track, off);
    if (!repair.struck.length) break;
    for (const cone of repair.struck) {
      if (!span.has(cone)) continue;
      span.set(cone, Math.min(4, span.get(cone) + 1));
      extra.set(cone, extra.get(cone) + 0.06);
    }
    buildBounds();
    solve(Math.max(400, Math.round(sweeps / 4)), false);
  }

  return {
    ...geometryFor(track, off),
    offsets: off, lo, hi,
    gates: gateCount, conePinches, wallHalfWidthM: r3(wall[0]),
    repairRounds: rounds,
    legal: {
      cones: repair.struck.length,
      missedGates: repair.missedGates,
      offSamples: repair.offSamples,
    },
  };
}

/**
 * The path, its arc lengths and its curvature, for a set of lateral offsets.
 *
 * Curvature is the circumradius through three consecutive points and is then
 * smoothed over +-2 m: a 1 m polyline differentiated twice is noisy, and noise
 * in curvature is a corner that is not there, which the pass would brake for.
 */
function geometryFor(track, off) {
  const n = track.center.length;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = track.heading[i];
    pts[i] = [
      track.center[i][0] - Math.sin(h) * off[i],
      track.center[i][1] + Math.cos(h) * off[i],
    ];
  }
  const m = n;
  const ds = new Float64Array(m), kap = new Float64Array(m);
  const at = (i) => pts[track.closed ? ((i % m) + m) % m : Math.max(0, Math.min(m - 1, i))];
  for (let i = 0; i < m; i++) {
    const a = at(i), b = at(i + 1);
    ds[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1);
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1];
    const bx = p2[0] - p1[0], by = p2[1] - p1[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
    kap[i] = la * lb * lc > 1e-9 ? (2 * (ax * by - ay * bx)) / (la * lb * lc) : 0;
  }
  if (!track.closed) ds[m - 1] = 0;
  let length = 0;
  for (let i = 0; i < m; i++) length += ds[i];
  const ks = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let sum = 0, w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = track.closed ? (((i + k) % m) + m) % m : Math.max(0, Math.min(m - 1, i + k));
      const ww = 3 - Math.abs(k);
      sum += kap[j] * ww; w += ww;
    }
    ks[i] = sum / w;
  }
  return { pts, ds, curvature: ks, lengthM: length, closed: !!track.closed };
}

/**
 * Refine a line for TIME rather than for curvature.
 *
 * Minimum curvature is not the fastest line and never was: the fastest line
 * sacrifices curvature on a corner exit to be pointing down the following
 * straight. That matters here because the FLOOR has to be a bound over every
 * admissible line, and a bound computed on a line that is merely smooth is not
 * one -- the first version of this file put the autocross floor at 41.76 s
 * against a human lap of 41.853 s, which is far too close to be trusted.
 *
 * So: coordinate descent on TAPERED BUMPS. The search variable is not one
 * node's offset (moving a single node 0.5 m puts a curvature spike in the path
 * and is always slower) but a raised-cosine bump of a given width centred on a
 * node, projected back into the corridor. Widths and amplitudes go coarse to
 * fine, and the objective is the quasi-static time itself.
 */
function refineLineForTime(track, base, env, { passes = 2, stride = 4, sweeps = 8, cyclic = false, laps = 1, fromRest = true } = {}) {
  const n = track.center.length;
  const off = Float64Array.from(base.offsets);
  const { lo, hi } = base;
  const evalOpts = { laps, fromRest, cyclic, sweeps };
  const score = (o) => qssPass(geometryFor(track, o), env, evalOpts).totalS;
  let bestT = score(off);
  const trial = new Float64Array(n);
  const widths = [24, 12, 6];
  const amps = [0.6, 0.3, 0.12];
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const w of widths) {
      for (const a of amps) {
        for (let c = 0; c < n; c += stride) {
          for (const sign of [1, -1]) {
            trial.set(off);
            for (let k = -w; k <= w; k++) {
              const i = track.closed ? (((c + k) % n) + n) % n : c + k;
              if (i < 0 || i >= n) continue;
              if (!track.closed && (i === 0 || i === n - 1)) continue;
              const taper = 0.5 * (1 + Math.cos((Math.PI * k) / (w + 1)));
              trial[i] = clamp(trial[i] + sign * a * taper, lo[i], hi[i]);
            }
            const t = score(trial);
            if (t < bestT - 1e-4) { bestT = t; off.set(trial); improved = true; }
          }
        }
      }
    }
    if (!improved) break;
  }
  return { ...geometryFor(track, off), offsets: off, lo, hi, gates: base.gates, conePinches: base.conePinches };
}

/**
 * Make a time-refined line legal again, giving back as little as possible.
 *
 * `refineLineForTime` moves the line with tapered bumps that respect the
 * corridor's lo/hi, and the corridor is a model -- so the refined line can put
 * the body into a cone that the line it started from cleared. Blending the
 * whole line back toward the legal one would hand back the entire time gain, so
 * the blend is LOCAL: only the stretch around each cone that is actually struck
 * is pulled back toward the legal line, over the span the body can reach from.
 * Repeated until the sweep is clean, which it must become, because at full
 * blend the line IS the legal one.
 */
function repairRefined(track, baseOff, refOff, rounds = 10) {
  const n = track.center.length;
  const out = Float64Array.from(refOff);
  const idxOf = (i) => (track.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const pull = new Float64Array(n); // how far each node has been dragged back, 0..1
  for (let r = 0; r < rounds; r++) {
    const { struck } = sweepStrikes(track, out);
    if (!struck.length) return { off: out, rounds: r, clean: true };
    for (const cone of struck) {
      const { index } = track.nearestIndex(cone.x, cone.y);
      const SPAN = 8;
      for (let k = -SPAN; k <= SPAN; k++) {
        const j = idxOf(index + k);
        const taper = 1 - Math.abs(k) / (SPAN + 1);
        pull[j] = Math.min(1, pull[j] + 0.34 * taper);
        out[j] = refOff[j] + (baseOff[j] - refOff[j]) * pull[j];
      }
    }
    track.lastIndex = 0;
  }
  const { struck } = sweepStrikes(track, out);
  return { off: out, rounds, clean: struck.length === 0 };
}

/**
 * The forward/backward pass.
 *
 * `env` supplies ayMax(v), axAccel(v), axBrake(v) in m/s^2 plus the ellipse
 * exponent. Everything is a speed-dependent limit, so the corner-speed step is
 * a small fixed-point iteration rather than one division.
 */
function qssPass(line, env, { laps = 1, fromRest = true, cyclic = false, sweeps: sweepsOverride = null } = {}) {
  const m = line.pts.length;
  const N = m * laps;
  const k = (i) => Math.abs(line.curvature[i % m]);
  const ds = (i) => line.ds[i % m];
  const vTop = 45; // m/s; the car has no accel left anywhere near this
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const kk = Math.max(k(i), 1e-6);
    let vi = vTop;
    for (let it = 0; it < 14; it++) vi = Math.min(vTop, 0.5 * vi + 0.5 * Math.sqrt(env.ayMax(vi) / kk));
    v[i] = Math.min(vTop, vi);
  }
  const axAvail = (vi, i, mode) => {
    const ayMax = env.ayMax(vi);
    const ay = Math.min(ayMax, vi * vi * k(i));
    const ny = ayMax > 0 ? Math.min(1, ay / ayMax) : 0;
    const scale = Math.max(0, 1 - ny ** env.exponent) ** (1 / env.exponent);
    return (mode === "accel" ? env.axAccel(vi) : env.axBrake(vi)) * scale;
  };
  const sweeps = sweepsOverride ?? (cyclic ? 80 : 16);
  for (let pass = 0; pass < sweeps; pass++) {
    for (let i = N - 2; i >= 0; i--) {
      const cap = Math.sqrt(Math.max(0, v[i + 1] ** 2 + 2 * axAvail(v[i], i, "brake") * ds(i)));
      if (cap < v[i]) v[i] = cap;
    }
    if (cyclic) {
      const cap = Math.sqrt(Math.max(0, v[0] ** 2 + 2 * axAvail(v[N - 1], N - 1, "brake") * ds(N - 1)));
      if (cap < v[N - 1]) v[N - 1] = cap;
    }
    if (fromRest) v[0] = 0;
    for (let i = 1; i < N; i++) {
      const cap = Math.sqrt(Math.max(0, v[i - 1] ** 2 + 2 * axAvail(v[i - 1], i - 1, "accel") * ds(i - 1)));
      if (cap < v[i]) v[i] = cap;
    }
    if (cyclic) {
      const cap = Math.sqrt(Math.max(0, v[N - 1] ** 2 + 2 * axAvail(v[N - 1], N - 1, "accel") * ds(N - 1)));
      if (cap < v[0]) v[0] = cap;
    }
  }
  const segT = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v0 = v[i];
    const v1 = i + 1 < N ? v[i + 1] : (cyclic ? v[0] : v[i]);
    const vm = 0.5 * (v0 + v1);
    // From rest the mean-speed form is singular, so the first segment is
    // integrated as constant-acceleration instead.
    segT[i] = vm > 0.05
      ? ds(i) / vm
      : (ds(i) > 0 ? 2 * Math.sqrt(ds(i) / Math.max(env.axAccel(0), 1)) : 0);
  }
  const lapTimes = [];
  for (let l = 0; l < laps; l++) {
    let t = 0;
    for (let i = l * m; i < (l + 1) * m; i++) t += segT[i];
    lapTimes.push(t);
  }
  let total = 0, peak = 0;
  for (let i = 0; i < N; i++) { total += segT[i]; peak = Math.max(peak, v[i]); }
  return { lapTimes, totalS: total, peakSpeedMps: peak, speeds: v };
}

// ---------------------------------------------------------------- main ----

const speeds = QUICK ? [8, 15, 22, 28] : [5, 8, 11, 14, 17, 20, 23, 26, 29];
const brakeSpeeds = QUICK ? [15, 25] : [8, 12, 16, 20, 24, 28, 30];
const accelSpeeds = QUICK ? [5, 15, 25] : [0.5, 1, 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32];
const combinedSpeeds = QUICK ? [15] : [11, 17, 23];

console.log("car_envelope: measuring the SDM26 from the model (this takes a minute)\n");

process.stdout.write("  (a) steady-state lateral ...");
const lateral = measureLateral(speeds);
console.log(" done");
process.stdout.write("  (a2) peak transient lateral ...");
const transient = transientLateral(speeds);
console.log(" done");
process.stdout.write("  (b) braking ...");
const braking = measureBraking(brakeSpeeds);
console.log(" done");
process.stdout.write("  (c) longitudinal ...");
const accel = measureAccel(accelSpeeds);
const accelPeak = accelEnvelopeSweep();
const launches = [standingStart(false), standingStart(true)];
console.log(" done");
process.stdout.write("  (d) combined ...");
const combined = measureCombined(lateral, combinedSpeeds);
const ellipse = fitEllipse(combined, lateral, accel, braking);
console.log(" done\n");

const ayMaxOf = lerpTable(lateral, "speedMps", "maxLatG");
const ayPeakOf = lerpTable(transient, "speedMps", "peakLatG");
const axAccelOf = lerpTable(accel, "speedMps", "maxAccelG");
const axAccelPeakOf = lerpTable(accelPeak, "speedMps", "peakAccelG");
const axBrakeOf = lerpTable(braking, "speedMps", "maxBrakeG");
const axBrakePeakOf = lerpTable(braking, "speedMps", "bestIgnoringLock");

// TWO envelopes, and the difference between them is the whole point.
//
// `env` is an UPPER bound on what the car can do -- the peak transient figure
// on every axis -- so the lap time it produces is a true LOWER bound: a floor
// nothing can get under. It is loose, because no car holds its peak transient
// lateral AND its peak transient longitudinal continuously.
//
// `envSteady` is the sustainable envelope: what the car will hold all day. The
// lap time from it is a realistic TARGET and not a bound -- and it is
// demonstrably beatable, because the human's best archived autocross run
// (41.853 s) beats the steady-envelope pass run on its own recorded line
// (43.1 s, measured).
const env = {
  ayMax: (v) => Math.max(0.05, ayMaxOf(v), ayPeakOf(v)) * G,
  axAccel: (v) => Math.max(0.02, axAccelOf(v), axAccelPeakOf(v)) * G,
  axBrake: (v) => Math.max(0.05, axBrakeOf(v), axBrakePeakOf(v)) * G,
  exponent: ellipse.exponent,
};
const envSteady = {
  ayMax: (v) => Math.max(0.05, ayMaxOf(v)) * G,
  axAccel: (v) => Math.max(0.02, axAccelOf(v)) * G,
  axBrake: (v) => Math.max(0.05, axBrakeOf(v)) * G,
  exponent: ellipse.exponent,
};

const bounds = {};
for (const id of ["autocross", "endurance"]) {
  const track = new Track(JSON.parse(fs.readFileSync(path.join(DATA, `track-${id}.json`), "utf8")));
  const minCurv = buildLine(track, { optimise: true });
  const lines = {
    centreline: buildLine(track, { optimise: false }),
    optimised: minCurv,
    // Refined for time on the FLOOR envelope, since the floor is the number
    // the other agent's lap gets judged against and it has to be a bound over
    // every line, not just over the smooth one.
    ...(NO_REFINE ? {} : { timeOptimised: (() => {
      const refined = refineLineForTime(track, minCurv, env, {
        laps: 1, fromRest: !track.closed, cyclic: !!track.closed,
        sweeps: track.closed ? 24 : 10, stride: track.closed ? 6 : 4,
      });
      const fixed = repairRefined(track, minCurv.offsets, refined.offsets);
      if (!fixed.clean) {
        console.log(`  WARNING: ${id} timeOptimised line could not be made legal; ` +
          `falling back to the minimum-curvature line`);
        return { ...minCurv };
      }
      return {
        ...geometryFor(track, fixed.off),
        offsets: fixed.off, lo: minCurv.lo, hi: minCurv.hi,
        gates: minCurv.gates, conePinches: minCurv.conePinches,
        repairRounds: fixed.rounds,
        legal: sweepStrikes(track, fixed.off),
      };
    })() }),
  };
  const out = {
    trackName: track.name, courseLengthM: track.length, closed: !!track.closed,
    offCourseHalfWidthM: r3(track.width / 2 + bodyBoxFor(SDM26).halfWidth),
    coneHalfWidthM: r3(track.width / 2 - bodyBoxFor(SDM26).halfWidth - 0.155),
    lines: {},
  };
  for (const [name, line] of Object.entries(lines)) {
    const lg = line.legal ?? sweepStrikes(track, line.offsets);
    const entry = {
      pathLengthM: r2(line.lengthM),
      gateConstraints: line.gates,
      conePinches: line.conePinches,
      // Swept with the real body box through the game's own strikeCones /
      // checkGates / locate. A line that is not clean here is not a floor for a
      // clean lap, whatever time it produces.
      legal: {
        conesStruck: Array.isArray(lg.struck) ? lg.struck.length : (lg.cones ?? 0),
        missedGates: lg.missedGates ?? 0,
        offCourseSamples: lg.offSamples ?? 0,
      },
      repairRounds: line.repairRounds ?? 0,
    };
    for (const [tag, e] of [["", env], ["Steady", envSteady]]) {
      if (track.closed) {
        const two = qssPass(line, e, { laps: 2, fromRest: true });
        const fly = qssPass(line, e, { laps: 1, fromRest: false, cyclic: true });
        entry[`twoLapsFromRest${tag}S`] = r3(two.totalS);
        entry[`lapSplits${tag}S`] = two.lapTimes.map((t) => r3(t));
        entry[`flyingLap${tag}S`] = r3(fly.lapTimes[0]);
        if (!tag) entry.peakSpeedKph = r2(fly.peakSpeedMps * 3.6);
      } else {
        const one = qssPass(line, e, { laps: 1, fromRest: true });
        entry[`oneLapFromRest${tag}S`] = r3(one.totalS);
        if (!tag) entry.peakSpeedKph = r2(one.peakSpeedMps * 3.6);
      }
    }
    let mx = 0;
    for (const o of line.offsets) mx = Math.max(mx, Math.abs(o));
    entry.maxLateralOffsetM = r2(mx);
    out.lines[name] = entry;

    // `--export-line`: the line itself, node by node, so something else can
    // read it. A summary table says how fast the bound is; this says WHERE it
    // is fast, which is the only form in which a bound can be argued with. One
    // row per centreline node: the lateral offset that defines the line and the
    // speed each envelope carries there.
    if (flag("export-line")) {
      const fly = track.closed
        ? qssPass(line, env, { laps: 1, fromRest: false, cyclic: true })
        : qssPass(line, env, { laps: 1, fromRest: true });
      const flyS = track.closed
        ? qssPass(line, envSteady, { laps: 1, fromRest: false, cyclic: true })
        : qssPass(line, envSteady, { laps: 1, fromRest: true });
      const file = path.join(OUT, `line-${id}-${name}.json`);
      fs.writeFileSync(file, JSON.stringify({
        track: id, line: name, closed: !!track.closed,
        note: "offsetM is the lateral offset from the centreline at centreline index i, " +
          "positive LEFT, the same sign as Track.locate().lateral. speedFloorMps is the " +
          "peak-transient (lower-bound) profile, speedSustainMps the steady-state one.",
        lapS: track.closed ? r3(fly.lapTimes[0]) : r3(fly.totalS),
        lapSteadyS: track.closed ? r3(flyS.lapTimes[0]) : r3(flyS.totalS),
        nodes: Array.from(line.offsets, (o, i) => ({
          i,
          sM: r2(track.s[i]),
          offsetM: r3(o),
          curvature: r3(line.curvature[i] * 1000) / 1000,
          speedFloorMps: r3(fly.speeds[i]),
          speedSustainMps: r3(flyS.speeds[i]),
        })),
      }));
      console.log(`  exported ${file}`);
    }
  }
  bounds[id] = out;
}

// --------------------------------------------------- validate the floor ---
//
// The floor has to be below every lap anybody has actually driven on that
// course. Nothing else checks this, and a floor that a real lap gets under is
// not a floor -- it is a number that will quietly certify a broken lap as
// legitimate.
const archive = archivedLaps();
const validation = [];
for (const [id, c] of Object.entries(bounds)) {
  const laps = archive[id] ?? [];
  if (!laps.length) { validation.push({ course: id, archivedLaps: 0, verdict: "no archived laps to check against" }); continue; }
  const floors = Object.entries(c.lines).map(([name, e]) => ({
    name,
    floorS: c.closed ? e.flyingLapS : e.oneLapFromRestS,
  })).filter((f) => f.floorS != null);
  const bestFloor = floors.reduce((b, f) => (b == null || f.floorS < b.floorS ? f : b), null);
  // On a closed course the floor to compare is the FLYING lap and only flying
  // laps may be compared with it; lap 1 starts from rest.
  const comparable = c.closed ? laps.filter((l) => l.flying) : laps;
  const fastest = comparable[0] ?? null;
  const ok = !fastest || fastest.rawS > bestFloor.floorS;
  validation.push({
    course: id,
    archivedLaps: comparable.length,
    fastestArchived: fastest ? { runId: fastest.runId, driver: fastest.driver, rawS: fastest.rawS, cones: fastest.cones, physics: fastest.physics } : null,
    lowestFloorS: bestFloor.floorS,
    lowestFloorLine: bestFloor.name,
    marginS: fastest ? r3(fastest.rawS - bestFloor.floorS) : null,
    verdict: ok ? "floor holds" : "FLOOR VIOLATED by a real lap -- the envelope or the line search is wrong",
  });
}

const report = {
  producer: "sim/tools/car_envelope.mjs",
  generatedAt: new Date().toISOString(),
  car: SDM26.name,
  method: {
    substepS: DT,
    note: "every number below is measured by stepping BicycleModel + Powertrain; none is read off a parameter",
    setupSnapshot: {
      massKg: SDM26.massKg, muLat: SDM26.muLat, frontGripFactor: SDM26.frontGripFactor,
      muLong: SDM26.muLong, brakeBiasFront: SDM26.brakeBiasFront,
      brakeTorqueMaxNm: SDM26.brakeTorqueMaxNm, rsdFront: SDM26.roll.rsdFront,
      aeroFrontFrac: SDM26.aeroFrontFrac, maxSteerDeg: SDM26.maxSteerDeg,
      claM2: SDM26.claM2, cdaM2: SDM26.cdaM2,
    },
    carBox: bodyBoxFor(SDM26),
  },
  lateral, transient, braking, accel, accelPeak, launches, combined, ellipse,
  validation,
  lapTimeBound: {
    note: "quasi-static forward/backward pass on the measured envelope; a LOWER BOUND -- " +
      "no tyre relaxation lag, no yaw inertia, no steering servo, no shift cuts in corners, " +
      "on the friction limit at every metre",
    ellipseExponent: ellipse.exponent,
    courses: bounds,
  },
};

fs.mkdirSync(OUT, { recursive: true });
const jsonPath = path.join(OUT, "car_envelope.json");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

// -------------------------------------------------------------- summary ---

const L = [];
const peakLat = lateral.filter((l) => l.maxLatG != null)
  .reduce((b, l) => (b == null || l.maxLatG > b.maxLatG ? l : b), null);
const peakBrake = braking.filter((b) => b.maxBrakeG != null)
  .reduce((b, r) => (b == null || r.maxBrakeG > b.maxBrakeG ? r : b), null);
L.push(`SDM26 measured envelope   ->  ${jsonPath}`);
L.push("");
L.push("(a) STEADY-STATE LATERAL   constant-speed steer sweep");
L.push("    v m/s    kph  gear   max lat g   at steer   radius m   utilF  utilR   limited by   throttle");
for (const l of lateral) {
  if (l.error) { L.push(`    ${padl(l.speedMps, 5)}   -- ${l.error}`); continue; }
  L.push(`    ${padl(l.speedMps, 5)}  ${padl(l.speedKph, 5)}    ${l.gear}      ${padl(l.maxLatG.toFixed(3), 6)}     ${padl(l.atSteerDeg.toFixed(2), 6)}    ${padl(l.radiusM.toFixed(1), 7)}   ${l.utilF.toFixed(2)}   ${l.utilR.toFixed(2)}   ${padr(l.limitingAxle, 9)}     ${l.throttleToHold.toFixed(2)}`);
}
if (peakLat) {
  L.push(`    peak ${peakLat.maxLatG.toFixed(3)} g at ${peakLat.speedMps} m/s (${peakLat.speedKph} km/h); ` +
    `${peakLat.limitingAxle} axle limits first at that point`);
}
L.push("");
L.push("(a2) PEAK TRANSIENT LATERAL   step steer, first second, before the load settles");
L.push("    v m/s    kph   peak lat g   at steer   body slip at peak");
for (const t of transient) {
  L.push(`    ${padl(t.speedMps, 5)}  ${padl(t.speedKph, 5)}   ${padl(t.peakLatG.toFixed(3), 8)}   ${padl(t.atSteerDeg.toFixed(2), 8)}   ${t.bodySlipAtPeakDeg.toFixed(2)} deg`);
}
L.push("");
L.push(`(b) BRAKING   bias fixed at ${SDM26.brakeBiasFront.toFixed(2)} front`);
L.push("    v m/s    kph   best pedal   max g   locks at pedal   locks first   full pedal g (locked?)");
for (const b of braking) {
  L.push(`    ${padl(b.speedMps, 5)}  ${padl(b.speedKph, 5)}   ${padl(String(b.bestPedal), 8)}   ${padl(String(b.maxBrakeG), 6)}   ${padl(String(b.lockThresholdPedal), 12)}   ${padl(String(b.locksFirst), 11)}   ${b.fullPedalG} (${b.fullPedalLocked ? "yes" : "no"})`);
}
if (peakBrake) L.push(`    peak ${peakBrake.maxBrakeG} g at ${peakBrake.speedMps} m/s on ${peakBrake.bestPedal} pedal`);
L.push("");
L.push("(c) LONGITUDINAL   full throttle at speed, best gear");
L.push("    v m/s    kph   max accel g   in gear   limit");
for (const a of accel) {
  L.push(`    ${padl(a.speedMps, 5)}  ${padl(a.speedKph, 5)}   ${padl(String(a.maxAccelG), 9)}   ${padl(String(a.inGear), 7)}   ${a.limit}`);
}
L.push("    peak TRANSIENT accel envelope (full-throttle runs; post-shift states included):");
{
  const cells = accelPeak.filter((p) => p.speedMps % 3 === 0)
    .map((p) => `${p.speedMps} m/s ${p.peakAccelG.toFixed(3)} g`);
  for (let i = 0; i < cells.length; i += 5) L.push(`      ${cells.slice(i, i + 5).join("   ")}`);
}
for (const s of launches) {
  L.push(`    standing start${s.launch ? ", WITH launch control" : ", no launch control"}: ` +
    `0-30 ${s.to30KphS} s, 0-60 ${s.to60KphS} s, 0-100 ${s.to100KphS} s, ` +
    `75 m ${s.accel75mS} s @ ${s.kphAt75m} km/h, peak ${s.peakAccelG} g`);
  L.push(`      shifts: ${s.shifts.map((x) => `${x.to} @ ${x.atS} s / ${x.rpm} rpm`).join(", ") || "none"}`);
}
L.push("");
L.push(`(d) COMBINED   friction-ellipse exponent ${ellipse.exponent} ` +
  `(rms ${ellipse.rms} over ${ellipse.samples} points; 2.00 would be a circle)`);
L.push("    v m/s   lat frac   lat g    accel g avail   brake g avail");
for (const c of combined) {
  L.push(`    ${padl(c.speedMps, 5)}   ${c.latFrac.toFixed(2)}       ${padl(String(c.latTargetG), 5)}    ${padl(String(c.accel.axG ?? c.accel.error), 9)}       ${padl(String(c.brake.axG ?? c.brake.error), 9)}`);
}
L.push("");
L.push("QUASI-STATIC LAP TIMES   forward/backward pass on the measured envelope");
L.push("  FLOOR    the peak-transient envelope. An upper bound on the car, so a LOWER");
L.push("           bound on the time. Nothing can get under it.");
L.push("  SUSTAIN  the steady-state envelope. A realistic target, NOT a bound: the");
L.push("           human's best archived autocross run (41.853 s) beats the");
L.push("           steady-envelope pass run on its own recorded line (43.1 s).");
for (const [id, c] of Object.entries(bounds)) {
  L.push("");
  L.push(`  ${id} -- ${c.trackName}, ${c.courseLengthM} m ${c.closed ? "closed" : "open"}; ` +
    `wall +-${c.offCourseHalfWidthM} m for the CG, pinched to +-${c.coneHalfWidthM} m at each cone`);
  for (const [name, e] of Object.entries(c.lines)) {
    const lgl = e.legal.conesStruck === 0 && e.legal.missedGates === 0 && e.legal.offCourseSamples === 0
      ? "CLEAN when the real body box is swept along it"
      : `NOT CLEAN: ${e.legal.conesStruck} cone(s), ${e.legal.missedGates} missed gate(s), ${e.legal.offCourseSamples} off-course sample(s)`;
    L.push(`    ${padr(name, 11)} path ${e.pathLengthM} m, peak ${e.peakSpeedKph} km/h, ` +
      `max offset ${e.maxLateralOffsetM} m, ${e.conePinches} cone pinches, ${e.gateConstraints} gate constraints`);
    L.push(`                ${lgl}${e.repairRounds ? ` (after ${e.repairRounds} repair round(s))` : ""}`);
    if (e.oneLapFromRestS != null) {
      L.push(`                1 lap from rest    FLOOR ${e.oneLapFromRestS} s    SUSTAIN ${e.oneLapFromRestSteadyS} s`);
    }
    if (e.twoLapsFromRestS != null) {
      L.push(`                2 laps from rest   FLOOR ${e.twoLapsFromRestS} s (${e.lapSplitsS.join(" + ")})    SUSTAIN ${e.twoLapsFromRestSteadyS} s (${e.lapSplitsSteadyS.join(" + ")})`);
      L.push(`                flying lap         FLOOR ${e.flyingLapS} s    SUSTAIN ${e.flyingLapSteadyS} s`);
    }
  }
}
L.push("");
L.push("FLOOR CHECKED AGAINST EVERY REAL ARCHIVED LAP");
for (const v of validation) {
  if (!v.archivedLaps) { L.push(`  ${v.course}: ${v.verdict}`); continue; }
  const f = v.fastestArchived;
  L.push(`  ${v.course}: fastest of ${v.archivedLaps} real laps is ${f.rawS} s raw ` +
    `(${f.driver}, ${f.runId}, ${f.cones} cones, ${f.physics}); ` +
    `lowest floor ${v.lowestFloorS} s on the ${v.lowestFloorLine} line; ` +
    `margin ${v.marginS} s -- ${v.verdict}`);
}
L.push("");
L.push("THE THREE LINES, AND WHICH NUMBER TO USE");
L.push("  centreline     the course's own centreline (still weaving the slaloms, whose");
L.push("                 cones sit on it). A sanity floor, not a target.");
L.push("  optimised      minimum curvature energy inside the corridor. Smooth, and NOT");
L.push("                 the fastest line -- the fastest line gives up curvature on a");
L.push("                 corner exit to point down the next straight.");
L.push("  timeOptimised  the same corridor, refined by coordinate descent on TAPERED");
L.push("                 BUMPS against the quasi-static time itself. This is the line");
L.push("                 whose FLOOR is the one to judge a closed-loop lap against.");
L.push("");
L.push("The FLOOR numbers are true lower bounds. The pass has no tyre relaxation lag, no");
L.push("yaw inertia, no steering servo and no shift cuts on the cornering-limited");
L.push("stretches; it sits exactly on the friction limit at every metre; and it is handed");
L.push("the car's PEAK TRANSIENT lateral and longitudinal capability as though it could");
L.push("hold both continuously, which it cannot. A closed-loop lap under the timeOptimised");
L.push("floor is a bug, not a lap. A lap between that floor and SUSTAIN is a good lap.");

const text = L.join("\n");
fs.writeFileSync(path.join(OUT, "car_envelope.txt"), text + "\n");
console.log(text);
if (flag("json")) console.log("\n" + JSON.stringify(report, null, 2));

function clamp(x, lo2, hi2) { return x < lo2 ? lo2 : x > hi2 ? hi2 : x; }
function padl(v, w) { return String(v).padStart(w); }
function padr(v, w) { return String(v).padEnd(w); }
function r0(v) { return Math.round(v); }
function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }
