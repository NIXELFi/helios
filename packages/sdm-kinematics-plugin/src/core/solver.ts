// Corner position solver — generic 6-DOF upright pose (v0.6.0).
//
// The upright is a rigid body parameterized by u = [tx, ty, tz, rx, ry, rz]:
// translation of the static wheel center plus a rotation vector (Rodrigues).
// Every suspension type contributes exactly five scalar constraints, and the
// drive constraint (wheel-center height = static + bump target) closes the
// 6×6 Newton system:
//   double-wishbone : LBJ→(lcaFront, lcaRear), UBJ→(ucaFront, ucaRear),
//                     toeOuter→tieInner distances                    (5)
//   macpherson      : LBJ→(lcaFront, lcaRear), toeOuter→tieInner, and the
//                     upright-fixed strut axis passing through the chassis
//                     top mount (2 projected components)             (5)
//   multilink5      : five link lengths, link 5 = the toe link       (5)
// Damped Newton with a numeric Jacobian; sweeps warm-start with the previous
// pose for continuity down the travel range.

import {
  type V3, add, sub, scale, dot, cross, unit, norm, dist,
  type RigidXform, rotateAboutAxis, solveLinear,
} from "./vec";
import type { AxleGeometry } from "./model";

export interface CornerSolveInput {
  /** Side-correct geometry (already mirrored for the right side). */
  geo: AxleGeometry;
  /** Wheel-center bump target relative to static, in (+ = compression). */
  dz: number;
  /** Rack travel along +Y in car coordinates (0 for the rear axle). */
  rack: number;
  /** Warm-start pose from a neighbouring solve. */
  guessPose?: number[];
  /** Legacy triad guess — accepted for API compatibility, unused. */
  guess?: [V3, V3, V3];
  /** Skip the extra rack-perturbation solve that recovers the multilink
   *  virtual steering axis (used internally to avoid recursion). */
  needSteerAxis?: boolean;
}

export interface CornerState {
  ok: boolean;
  /** Steering-axis endpoints + toe-link outer, by type:
   *  double-wishbone → LBJ / UBJ / toe outer;
   *  macpherson → LBJ / strut top / toe outer;
   *  multilink5 → virtual axis low / high (screw axis) / link-5 outer. */
  p1: V3;
  p2: V3;
  p3: V3;
  xform: RigidXform;
  /** Solved pose [tx,ty,tz,rx,ry,rz] — pass back as guessPose. */
  poseU: number[];
  wheelCenter: V3;
  wheelAxisOuter: V3;
  /** Current inboard toe-link point (rack end after travel). */
  tieInner: V3;
  /** Pushrod outboard end / direct-coilover outboard eye, displaced. */
  pushLower: V3;
  /** Pushrod rocker-side end after rocker rotation. */
  pushUpper: V3;
  /** Shock rocker-side eye after rocker rotation (or the moving shock eye
   *  for direct/strut configurations). */
  shockRocker: V3;
  rockerAngle: number;
  shockLength: number;
  /** U-bar droplink pickup in its displaced position (rides ubarOn host). */
  ubarNsma: V3;
  /** U-bar lever-arm end after arm rotation about the chassis pivot. */
  ubarArm: V3;
  /** U-bar lever-arm rotation about its lateral +Y pivot axis, rad. NaN
   *  when config.arb === "none" or the arm solve fails. */
  ubarAngle: number;
  /** Decoupling-element pickups (rocker-fixed), displaced. */
  thirdRocker: V3;
  rollRocker: V3;
}

const MAX_ITER = 60;
const TOL = 1e-10;

/** Rotation matrix (as three column-applied ops) from a rotation vector. */
function rotFromVec(r: V3): (v: V3) => V3 {
  const angle = norm(r);
  if (angle < 1e-12) return (v) => [v[0], v[1], v[2]];
  const axis = scale(r, 1 / angle);
  const c = Math.cos(angle), s = Math.sin(angle);
  return (v) => {
    const term1 = scale(v, c);
    const term2 = scale(cross(axis, v), s);
    const term3 = scale(axis, dot(axis, v) * (1 - c));
    return add(add(term1, term2), term3);
  };
}

interface PoseMap {
  apply: (q: V3) => V3;
  applyDir: (d: V3) => V3;
}

function poseMap(wc: V3, u: number[]): PoseMap {
  const R = rotFromVec([u[3], u[4], u[5]]);
  const t: V3 = [u[0], u[1], u[2]];
  return {
    apply: (q) => add(add(wc, t), R(sub(q, wc))),
    applyDir: R,
  };
}

const d2 = (a: V3, b: V3) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/** Assemble the five geometry residuals + drive for a pose. */
function residuals(g: AxleGeometry, tieInnerCur: V3, ml5InCur: V3, targetWcZ: number, u: number[]): number[] {
  const pm = poseMap(g.wheelCenter, u);
  const r: number[] = [];
  const type = g.config.type;
  if (type === "double-wishbone") {
    const p1 = pm.apply(g.lbj);
    const p2 = pm.apply(g.ubj);
    const p3 = pm.apply(g.tieOuter);
    r.push(
      d2(p1, g.lcaFront) - d2(g.lbj, g.lcaFront),
      d2(p1, g.lcaRear) - d2(g.lbj, g.lcaRear),
      d2(p2, g.ucaFront) - d2(g.ubj, g.ucaFront),
      d2(p2, g.ucaRear) - d2(g.ubj, g.ucaRear),
      d2(p3, tieInnerCur) - d2(g.tieOuter, g.tieInner),
    );
  } else if (type === "macpherson") {
    const p1 = pm.apply(g.lbj);
    const p3 = pm.apply(g.tieOuter);
    // Strut: the upright-fixed axis (through strutLower, along the static
    // strutLower→strutTop direction) must pass through the chassis top
    // mount. Two projected components of the cross product, scaled toward
    // the squared-distance magnitudes.
    const d0 = unit(sub(g.strutTop, g.strutLower));
    // Fixed orthonormal pair ⊥ static axis.
    const tmp: V3 = Math.abs(d0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(cross(d0, tmp));
    const e2 = cross(d0, e1);
    const aCur = pm.apply(g.strutLower);
    const dCur = pm.applyDir(d0);
    const cr = cross(sub(g.strutTop, aCur), dCur);
    r.push(
      d2(p1, g.lcaFront) - d2(g.lbj, g.lcaFront),
      d2(p1, g.lcaRear) - d2(g.lbj, g.lcaRear),
      d2(p3, tieInnerCur) - d2(g.tieOuter, g.tieInner),
      dot(cr, e1) * 10,
      dot(cr, e2) * 10,
    );
  } else {
    // multilink5 — link 5 is the toe link; its inner end rides the rack.
    const pairs: [V3, V3][] = [
      [g.ml1Out, g.ml1In],
      [g.ml2Out, g.ml2In],
      [g.ml3Out, g.ml3In],
      [g.ml4Out, g.ml4In],
    ];
    for (const [out, inn] of pairs) r.push(d2(pm.apply(out), inn) - d2(out, inn));
    r.push(d2(pm.apply(g.ml5Out), ml5InCur) - d2(g.ml5Out, g.ml5In));
  }
  // Drive: wheel-center height. world(wc) = wc + t, so this is pure tz.
  r.push((g.wheelCenter[2] + u[2] - targetWcZ) * 20);
  return r;
}

/** Signed rotation of an A-arm about its inboard hinge, recovered from the
 *  displaced ball joint. Used to carry arm-mounted pushrod pickups along. */
function armAngle(
  hingeA: V3, hingeB: V3, bjStatic: V3, bjCur: V3,
): { origin: V3; axis: V3; angle: number } {
  const origin = hingeA;
  const axis = unit(sub(hingeB, hingeA));
  const proj = (p: V3): V3 => {
    const v = sub(p, origin);
    return sub(v, scale(axis, dot(v, axis)));
  };
  const a = proj(bjStatic);
  const b = proj(bjCur);
  const cosA = dot(unit(a), unit(b));
  const sinA = dot(axis, cross(a, b)) / (norm(a) * norm(b));
  return { origin, axis, angle: Math.atan2(sinA, Math.min(1, Math.max(-1, cosA))) };
}

/** Angle of a body rotating about a fixed axis so a link of fixed length
 *  reaches `anchor`: |rotate(pt, θ) − anchor| = L. 1-D Newton. */
function solveLinkAngle(
  pt: V3, origin: V3, axis: V3, anchor: V3, L2: number, guess: number,
): number | null {
  const f = (th: number) => {
    const p = rotateAboutAxis(pt, origin, axis, th);
    return dist(p, anchor) ** 2 - L2;
  };
  let th = guess;
  for (let i = 0; i < 50; i++) {
    const r = f(th);
    if (Math.abs(r) < 1e-10) return th;
    const h = 1e-6;
    const dr = (f(th + h) - f(th - h)) / (2 * h);
    if (Math.abs(dr) < 1e-12) return null;
    let step = r / dr;
    if (Math.abs(step) > 0.5) step = Math.sign(step) * 0.5;
    th -= step;
  }
  return Math.abs(f(th)) < 1e-6 ? th : null;
}

/** Rocker angle from the pushrod length constraint. */
function solveRocker(g: AxleGeometry, pushLowerCur: V3, guess: number): number | null {
  return solveLinkAngle(
    g.pushUpper, g.rockerAxis1, unit(sub(g.rockerAxis2, g.rockerAxis1)),
    pushLowerCur, dist(g.pushUpper, g.pushLower) ** 2, guess,
  );
}

/** Carry a point that rides a host body (arm, upright) to its displaced
 *  position. `rockerFn` handles rocker-fixed pickups. */
function carryHostPoint(
  g: AxleGeometry, host: "rocker" | "lca" | "uca" | "upright",
  q: V3, pm: PoseMap, p1: V3, p2ForUca: V3 | null,
  rockerFn: (q: V3) => V3,
): V3 {
  if (host === "rocker") return rockerFn(q);
  if (host === "upright") return pm.apply(q);
  if (host === "uca" && p2ForUca) {
    const { origin, axis, angle } = armAngle(g.ucaFront, g.ucaRear, g.ubj, p2ForUca);
    return rotateAboutAxis(q, origin, axis, angle);
  }
  const { origin, axis, angle } = armAngle(g.lcaFront, g.lcaRear, g.lbj, p1);
  return rotateAboutAxis(q, origin, axis, angle);
}

export function solveCorner(input: CornerSolveInput): CornerState {
  const g = input.geo;
  const cfg = g.config;
  const tieInnerCur: V3 = [g.tieInner[0], g.tieInner[1] + input.rack, g.tieInner[2]];
  const ml5InCur: V3 = [g.ml5In[0], g.ml5In[1] + input.rack, g.ml5In[2]];
  const targetWcZ = g.wheelCenter[2] + input.dz;

  let u: number[] = input.guessPose ? input.guessPose.slice() : [0, 0, 0, 0, 0, 0];

  let ok = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const r = residuals(g, tieInnerCur, ml5InCur, targetWcZ, u);
    const err = r.reduce((s, v) => s + v * v, 0);
    if (err < TOL) { ok = true; break; }
    const J: number[][] = [];
    for (let i = 0; i < 6; i++) J.push(new Array(6).fill(0));
    const h = 1e-5;
    for (let c = 0; c < 6; c++) {
      const up = u.slice(); up[c] += h;
      const dn = u.slice(); dn[c] -= h;
      const rp = residuals(g, tieInnerCur, ml5InCur, targetWcZ, up);
      const rn = residuals(g, tieInnerCur, ml5InCur, targetWcZ, dn);
      for (let row = 0; row < 6; row++) J[row][c] = (rp[row] - rn[row]) / (2 * h);
    }
    const step = solveLinear(J, r.slice());
    if (!step) break;
    // Damp: translations capped at 1.5", rotations at 0.3 rad per step —
    // keeps Newton on the correct assembly branch.
    let damp = 1;
    for (let i = 0; i < 3; i++) damp = Math.min(damp, 1.5 / Math.max(1e-12, Math.abs(step[i])));
    for (let i = 3; i < 6; i++) damp = Math.min(damp, 0.3 / Math.max(1e-12, Math.abs(step[i])));
    for (let i = 0; i < 6; i++) u[i] -= step[i] * Math.min(1, damp);
  }

  const pm = poseMap(g.wheelCenter, u);
  const xform: RigidXform = { apply: pm.apply, applyDir: pm.applyDir };
  const wheelCenter = pm.apply(g.wheelCenter);
  const wheelAxisOuter = pm.apply(g.wheelAxisOuter);

  // Steering-axis endpoints + toe outer, by type.
  let p1: V3, p2: V3, p3: V3;
  if (cfg.type === "double-wishbone") {
    p1 = pm.apply(g.lbj);
    p2 = pm.apply(g.ubj);
    p3 = pm.apply(g.tieOuter);
  } else if (cfg.type === "macpherson") {
    p1 = pm.apply(g.lbj);
    p2 = g.strutTop; // chassis-fixed — the kingpin runs LBJ → top mount
    p3 = pm.apply(g.tieOuter);
  } else {
    p3 = pm.apply(g.ml5Out);
    // Virtual steering axis via the instantaneous screw of a small rack
    // perturbation. Falls back to link-outer averages for unsteered axles.
    let low: V3 = scale(add(pm.apply(g.ml1Out), pm.apply(g.ml2Out)), 0.5);
    let high: V3 = scale(add(pm.apply(g.ml3Out), pm.apply(g.ml4Out)), 0.5);
    if (input.needSteerAxis !== false) {
      const dR = 0.02;
      const pert = solveCorner({ geo: g, dz: input.dz, rack: input.rack + dR, guessPose: u, needSteerAxis: false });
      if (pert.ok) {
        const w: V3 = [pert.poseU[3] - u[3], pert.poseU[4] - u[4], pert.poseU[5] - u[5]];
        const wMag = norm(w);
        if (wMag > 1e-6) {
          const axis = scale(w, 1 / wMag);
          // Screw-axis point closest to the wheel center: c = x + ω×v/|ω|².
          const x = wheelCenter;
          const v = sub(pert.wheelCenter, wheelCenter);
          const c = add(x, scale(cross(w, v), 1 / (wMag * wMag)));
          const at = (z: number): V3 => {
            const t = Math.abs(axis[2]) > 1e-6 ? (z - c[2]) / axis[2] : 0;
            return add(c, scale(axis, t));
          };
          low = at(low[2]);
          high = at(high[2]);
        }
      }
    }
    p1 = low;
    p2 = high;
  }

  // ---- Actuation chain ----
  let rockerAngle = 0;
  let pushLowerCur: V3 = g.pushLower;
  let pushUpperCur: V3 = g.pushUpper;
  let shockRockerCur: V3 = g.shockRocker;
  let shockLength: number;
  const rockerOrigin = g.rockerAxis1;
  const rockerAxis = unit(sub(g.rockerAxis2, g.rockerAxis1));
  const rockerFn = (q: V3) => rotateAboutAxis(q, rockerOrigin, rockerAxis, rockerAngle);
  const p2Body = cfg.type === "double-wishbone" ? pm.apply(g.ubj) : null;

  if (cfg.type === "macpherson") {
    // The strut IS the spring/damper: length from the (moving) upright axis
    // point to the fixed top mount.
    shockRockerCur = pm.apply(g.strutLower);
    shockLength = dist(shockRockerCur, g.strutTop);
  } else if (cfg.actuation === "direct-coilover") {
    pushLowerCur = carryHostPoint(g, g.pushrodOn, g.pushLower, pm, pm.apply(g.lbj), p2Body, rockerFn);
    shockRockerCur = pushLowerCur;
    shockLength = dist(pushLowerCur, g.shockChassis);
  } else if (cfg.actuation === "rocker-arm") {
    // The UCA doubles as the rocker: the shock eye is UCA-fixed.
    const { origin, axis, angle } = armAngle(g.ucaFront, g.ucaRear, g.ubj, p2Body ?? pm.apply(g.ubj));
    rockerAngle = angle;
    shockRockerCur = rotateAboutAxis(g.shockRocker, origin, axis, angle);
    shockLength = dist(shockRockerCur, g.shockChassis);
  } else {
    // pushrod-rocker / pullrod-rocker (identical math; naming only).
    pushLowerCur = carryHostPoint(g, g.pushrodOn, g.pushLower, pm, pm.apply(g.lbj), p2Body, rockerFn);
    rockerAngle = solveRocker(g, pushLowerCur, 0) ?? 0;
    pushUpperCur = rotateAboutAxis(g.pushUpper, rockerOrigin, rockerAxis, rockerAngle);
    shockRockerCur = rotateAboutAxis(g.shockRocker, rockerOrigin, rockerAxis, rockerAngle);
    shockLength = dist(shockRockerCur, g.shockChassis);
  }

  // ---- U-bar / Z-bar ----
  let ubarNsmaCur: V3 = g.ubarNsma;
  let ubarArmCur: V3 = g.ubarArm;
  let ubarAngle = NaN;
  if (cfg.arb !== "none") {
    ubarNsmaCur = carryHostPoint(g, g.ubarOn, g.ubarNsma, pm, pm.apply(g.lbj), p2Body, rockerFn);
    const psi = solveLinkAngle(
      g.ubarArm, g.ubarPivot, [0, 1, 0],
      ubarNsmaCur, dist(g.ubarArm, g.ubarNsma) ** 2, 0,
    );
    if (psi !== null) {
      ubarAngle = psi;
      ubarArmCur = rotateAboutAxis(g.ubarArm, g.ubarPivot, [0, 1, 0], psi);
    }
  }

  // Decoupling-element pickups ride the rocker (or the shock eye when there
  // is no rocker — direct/strut — so decoupled rates still mean something).
  const hasRocker = cfg.type !== "macpherson" &&
    (cfg.actuation === "pushrod-rocker" || cfg.actuation === "pullrod-rocker");
  const thirdRockerCur = hasRocker ? rockerFn(g.thirdRocker)
    : add(g.thirdRocker, sub(shockRockerCur, g.shockRocker));
  const rollRockerCur = hasRocker ? rockerFn(g.rollRocker)
    : add(g.rollRocker, sub(shockRockerCur, g.shockRocker));

  return {
    ok,
    p1, p2, p3,
    xform,
    poseU: u,
    wheelCenter,
    wheelAxisOuter,
    tieInner: cfg.type === "multilink5" ? ml5InCur : tieInnerCur,
    pushLower: pushLowerCur,
    pushUpper: pushUpperCur,
    shockRocker: shockRockerCur,
    rockerAngle,
    shockLength,
    ubarNsma: ubarNsmaCur,
    ubarArm: ubarArmCur,
    ubarAngle,
    thirdRocker: thirdRockerCur,
    rollRocker: rollRockerCur,
  };
}

/** Convenience: static (unbumped, unsteered) state — exact by construction. */
export function staticCorner(geo: AxleGeometry): CornerState {
  return solveCorner({ geo, dz: 0, rack: 0 });
}
