// Corner position solver.
//
// The upright is a rigid body carrying three joints: the lower ball joint
// (p1), the upper ball joint (p2) and the outer toe-link joint (p3). Nine
// unknowns (their coordinates), nine equations:
//   4× A-arm link lengths (each ball joint keeps its distance to both
//      inboard pickups — equivalent to the ball joint riding the circle
//      about the A-arm hinge axis),
//   1× toe-link length (inboard end moves with the rack on a steered axle),
//   3× rigid-upright distances between p1/p2/p3,
//   1× drive constraint: wheel-center height = static height + bump target.
// Solved with damped Newton–Raphson and a numerical Jacobian; each sweep step
// warm-starts from the previous solution for continuity down the travel range.

import {
  type V3, add, sub, scale, dot, unit, dist, clone,
  rigidFromTriad, type RigidXform, rotateAboutAxis, solveLinear,
} from "./vec";
import type { AxleGeometry } from "./model";

export interface CornerSolveInput {
  /** Side-correct geometry (already mirrored for the right side). */
  geo: AxleGeometry;
  /** Wheel-center bump target relative to static, in (+ = compression). */
  dz: number;
  /** Rack travel along +Y in car coordinates (0 for the rear axle). */
  rack: number;
  /** Warm-start guess from a neighbouring solve. */
  guess?: [V3, V3, V3];
}

export interface CornerState {
  ok: boolean;
  p1: V3; // LBJ
  p2: V3; // UBJ
  p3: V3; // toe-link outer
  xform: RigidXform;
  wheelCenter: V3;
  wheelAxisOuter: V3;
  /** Current inboard toe-link point (rack end after travel). */
  tieInner: V3;
  /** Pushrod outboard end in its displaced position. */
  pushLower: V3;
  /** Pushrod rocker-side end after rocker rotation. */
  pushUpper: V3;
  /** Shock rocker-side eye after rocker rotation. */
  shockRocker: V3;
  rockerAngle: number;
  shockLength: number;
  /** U-bar droplink pickup in its displaced position (rides ubarOn host). */
  ubarNsma: V3;
  /** U-bar lever-arm end after arm rotation about the chassis pivot. */
  ubarArm: V3;
  /** U-bar lever-arm rotation about its lateral pivot axis, rad.
   *  Left and right corners use the SAME axis direction (+Y), so equal bump
   *  gives opposite signs and axle twist = ψ_L + ψ_R. NaN if no U-bar. */
  ubarAngle: number;
}

const MAX_ITER = 60;
const TOL = 1e-10;

function residuals(g: AxleGeometry, tieInnerCur: V3, targetWcZ: number, u: number[]): number[] {
  const p1: V3 = [u[0], u[1], u[2]];
  const p2: V3 = [u[3], u[4], u[5]];
  const p3: V3 = [u[6], u[7], u[8]];
  const d2 = (a: V3, b: V3) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  };
  const s1 = g.lbj, s2 = g.ubj, s3 = g.tieOuter;
  // Wheel-center height via the rigid-triad transform.
  const wc = rigidFromTriad(s1, s2, s3, p1, p2, p3).apply(g.wheelCenter);
  return [
    d2(p1, g.lcaFront) - d2(s1, g.lcaFront),
    d2(p1, g.lcaRear) - d2(s1, g.lcaRear),
    d2(p2, g.ucaFront) - d2(s2, g.ucaFront),
    d2(p2, g.ucaRear) - d2(s2, g.ucaRear),
    d2(p3, tieInnerCur) - d2(s3, g.tieInner),
    d2(p1, p2) - d2(s1, s2),
    d2(p1, p3) - d2(s1, s3),
    d2(p2, p3) - d2(s2, s3),
    (wc[2] - targetWcZ) * 20, // scale height error toward the d² magnitudes
  ];
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
  const sinA = dot(axis, [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
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

export function solveCorner(input: CornerSolveInput): CornerState {
  const g = input.geo;
  const tieInnerCur: V3 = [g.tieInner[0], g.tieInner[1] + input.rack, g.tieInner[2]];
  const targetWcZ = g.wheelCenter[2] + input.dz;

  let u: number[] = input.guess
    ? [...input.guess[0], ...input.guess[1], ...input.guess[2]]
    : [...g.lbj, ...g.ubj, ...g.tieOuter];

  let ok = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const r = residuals(g, tieInnerCur, targetWcZ, u);
    const err = r.reduce((s, v) => s + v * v, 0);
    if (err < TOL) { ok = true; break; }
    // Numerical Jacobian (central differences).
    const J: number[][] = [];
    for (let i = 0; i < 9; i++) J.push(new Array(9).fill(0));
    const h = 1e-5;
    for (let c = 0; c < 9; c++) {
      const up = u.slice(); up[c] += h;
      const dn = u.slice(); dn[c] -= h;
      const rp = residuals(g, tieInnerCur, targetWcZ, up);
      const rn = residuals(g, tieInnerCur, targetWcZ, dn);
      for (let row = 0; row < 9; row++) J[row][c] = (rp[row] - rn[row]) / (2 * h);
    }
    const step = solveLinear(J, r.slice());
    if (!step) break;
    // Damp huge steps — keeps Newton on the correct assembly branch.
    let maxStep = 0;
    for (const s of step) maxStep = Math.max(maxStep, Math.abs(s));
    const damp = maxStep > 1.5 ? 1.5 / maxStep : 1;
    for (let i = 0; i < 9; i++) u[i] -= step[i] * damp;
  }

  const p1: V3 = [u[0], u[1], u[2]];
  const p2: V3 = [u[3], u[4], u[5]];
  const p3: V3 = [u[6], u[7], u[8]];
  const xform = rigidFromTriad(g.lbj, g.ubj, g.tieOuter, p1, p2, p3);
  const wheelCenter = xform.apply(g.wheelCenter);
  const wheelAxisOuter = xform.apply(g.wheelAxisOuter);

  // Pushrod outboard end rides its host body: LCA, UCA, or the upright.
  let pushLowerCur: V3;
  if (g.pushrodOn === "upright") {
    pushLowerCur = xform.apply(g.pushLower);
  } else if (g.pushrodOn === "uca") {
    const { origin, axis, angle } = armAngle(g.ucaFront, g.ucaRear, g.ubj, p2);
    pushLowerCur = rotateAboutAxis(g.pushLower, origin, axis, angle);
  } else {
    const { origin, axis, angle } = armAngle(g.lcaFront, g.lcaRear, g.lbj, p1);
    pushLowerCur = rotateAboutAxis(g.pushLower, origin, axis, angle);
  }
  const th = solveRocker(g, pushLowerCur, 0) ?? 0;
  const rockerOrigin = g.rockerAxis1;
  const rockerAxis = unit(sub(g.rockerAxis2, g.rockerAxis1));
  const pushUpperCur = rotateAboutAxis(g.pushUpper, rockerOrigin, rockerAxis, th);
  const shockRockerCur = rotateAboutAxis(g.shockRocker, rockerOrigin, rockerAxis, th);

  // U-bar: carry the droplink pickup with its host body, then rotate the
  // lever arm about the lateral (+Y) pivot axis to keep the droplink length.
  let ubarNsmaCur: V3 = g.ubarNsma;
  let ubarArmCur: V3 = g.ubarArm;
  let ubarAngle = NaN;
  if (g.ubarNsma && g.ubarArm && g.ubarPivot) {
    if (g.ubarOn === "rocker") {
      ubarNsmaCur = rotateAboutAxis(g.ubarNsma, rockerOrigin, rockerAxis, th);
    } else if (g.ubarOn === "uca") {
      const { origin, axis, angle } = armAngle(g.ucaFront, g.ucaRear, g.ubj, p2);
      ubarNsmaCur = rotateAboutAxis(g.ubarNsma, origin, axis, angle);
    } else if (g.ubarOn === "lca") {
      const { origin, axis, angle } = armAngle(g.lcaFront, g.lcaRear, g.lbj, p1);
      ubarNsmaCur = rotateAboutAxis(g.ubarNsma, origin, axis, angle);
    } else {
      ubarNsmaCur = xform.apply(g.ubarNsma);
    }
    const psi = solveLinkAngle(
      g.ubarArm, g.ubarPivot, [0, 1, 0],
      ubarNsmaCur, dist(g.ubarArm, g.ubarNsma) ** 2, 0,
    );
    if (psi !== null) {
      ubarAngle = psi;
      ubarArmCur = rotateAboutAxis(g.ubarArm, g.ubarPivot, [0, 1, 0], psi);
    }
  }

  return {
    ok,
    p1, p2, p3,
    xform,
    wheelCenter,
    wheelAxisOuter,
    tieInner: tieInnerCur,
    pushLower: pushLowerCur,
    pushUpper: pushUpperCur,
    shockRocker: shockRockerCur,
    rockerAngle: th,
    shockLength: dist(shockRockerCur, g.shockChassis),
    ubarNsma: ubarNsmaCur,
    ubarArm: ubarArmCur,
    ubarAngle,
  };
}

/** Convenience: static (unbumped, unsteered) state — exact by construction. */
export function staticCorner(geo: AxleGeometry): CornerState {
  return solveCorner({ geo, dz: 0, rack: 0 });
}

export { clone as cloneV3 };
