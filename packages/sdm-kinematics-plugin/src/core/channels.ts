// Output channels — the OptimumKinematics catalogue, computed from solved
// corner states. Sign conventions (SAE, X+ fwd / Y+ left / Z+ up):
//   camber   − = top of tire leans inboard
//   toe      + = toe-in
//   caster   + = top of kingpin axis leans rearward
//   KPI      + = top of kingpin axis leans inboard
//   trail    + = contact patch behind the steering-axis ground intercept
//   scrub    + = contact patch outboard of the steering-axis ground intercept
//   steer    + = wheel steered left

import { type V3, sub, add, scale, unit, dot, cross, deg } from "./vec";
import type { AxleGeometry, VehicleParams } from "./model";
import { solveCorner, type CornerState } from "./solver";

export type Side = 1 | -1; // +1 left, −1 right

export interface CornerChannels {
  camber: number;
  toe: number;
  steer: number;
  caster: number;
  kpi: number;
  mechTrail: number;
  scrub: number;
  contactPatch: V3;
  wheelAxis: V3; // unit, outboard-pointing
  shockLength: number;
  /** Installation ratio dShock/dWheel (in/in) and resulting wheel rate. */
  installRatio: number;
  wheelRate: number;
}

export function cornerChannels(
  geo: AxleGeometry,
  st: CornerState,
  side: Side,
  params: VehicleParams,
  springRate: number,
  dz: number,
  rack: number,
  /** Skip the ±bump probe solves (installation ratio / wheel rate become
   *  NaN). The optimizer uses this to evaluate cheap channels fast. */
  skipProbes = false,
): CornerChannels {
  let a = unit(sub(st.wheelAxisOuter, st.wheelCenter));
  if (a[1] * side < 0) a = scale(a, -1); // point outboard

  const camber = -deg(Math.asin(Math.max(-1, Math.min(1, a[2]))));

  // Wheel heading: axis × up, flipped to point forward.
  let f = unit(cross(a, [0, 0, 1]));
  if (f[0] < 0) f = scale(f, -1);
  const steer = deg(Math.atan2(f[1], f[0]));
  const toe = -side * steer;

  const k = unit(sub(st.p2, st.p1)); // kingpin, z up
  const caster = deg(Math.atan2(-k[0], k[2]));
  const kpi = deg(Math.atan2(-side * k[1], k[2]));

  // Contact patch: tire radius down along the wheel-plane vertical.
  const w: V3 = unit([-a[0] * a[2], -a[1] * a[2], 1 - a[2] * a[2]]);
  const contactPatch = sub(st.wheelCenter, scale(w, params.tireRadius));

  // Kingpin-axis ground intercept at contact-patch height.
  const t = (contactPatch[2] - st.p1[2]) / (k[2] || 1e-9);
  const g = add(st.p1, scale(k, t));
  const mechTrail = g[0] - contactPatch[0];
  const scrub = side * (contactPatch[1] - g[1]);

  // Installation ratio via central difference on the bump target.
  let installRatio = NaN;
  let wheelRate = NaN;
  if (!skipProbes) {
    const H = 0.05;
    const up = solveCorner({ geo, dz: dz + H, rack, guess: [st.p1, st.p2, st.p3] });
    const dn = solveCorner({ geo, dz: dz - H, rack, guess: [st.p1, st.p2, st.p3] });
    installRatio = (up.shockLength - dn.shockLength) / (2 * H);
    wheelRate = springRate * installRatio * installRatio;
  }

  return {
    camber, toe, steer, caster, kpi, mechTrail, scrub,
    contactPatch, wheelAxis: a,
    shockLength: st.shockLength,
    installRatio: Number.isFinite(installRatio) ? Math.abs(installRatio) : NaN,
    wheelRate,
  };
}

export interface AxleChannels {
  /** Kinematic roll center in the front view (y, z), in. */
  rollCenter: [number, number];
  /** Front-view instant centers per side (y, z) — null when at infinity. */
  icLeft: [number, number] | null;
  icRight: [number, number] | null;
  /** Anti-dive (front, braking) or anti-squat (rear, accel), %. */
  antiPct: number;
  /** Bump steer at the current position, deg/in. */
  bumpSteerLeft: number;
  bumpSteerRight: number;
  /** Camber gain, deg/in of bump. */
  camberGainLeft: number;
  camberGainRight: number;
}

interface SideProbe {
  cp: V3;
  vy: number; // d(cp_y)/d(bump)
  vx: number; // d(cp_x)/d(bump)
  omega: number; // front-view upright rotation, rad per in of bump
  dToe: number;
  dCamber: number;
}

function probeSide(
  geo: AxleGeometry, side: Side, params: VehicleParams,
  dz: number, rack: number, st: CornerState,
): SideProbe {
  const H = 0.05;
  const solveAt = (d: number) => solveCorner({ geo, dz: d, rack, guess: [st.p1, st.p2, st.p3] });
  const chanAt = (s: CornerState) => {
    let a = unit(sub(s.wheelAxisOuter, s.wheelCenter));
    if (a[1] * side < 0) a = scale(a, -1);
    const w: V3 = unit([-a[0] * a[2], -a[1] * a[2], 1 - a[2] * a[2]]);
    const cp = sub(s.wheelCenter, scale(w, params.tireRadius));
    const fv = Math.atan2(a[2], side * a[1]); // front-view axis angle
    let f = unit(cross(a, [0, 0, 1]));
    if (f[0] < 0) f = scale(f, -1);
    const camber = -deg(Math.asin(Math.max(-1, Math.min(1, a[2]))));
    const toe = -side * deg(Math.atan2(f[1], f[0]));
    return { cp, fv, camber, toe };
  };
  const cur = chanAt(st);
  const up = chanAt(solveAt(dz + H));
  const dn = chanAt(solveAt(dz - H));
  return {
    cp: cur.cp,
    vy: (up.cp[1] - dn.cp[1]) / (2 * H),
    vx: (up.cp[0] - dn.cp[0]) / (2 * H),
    omega: (up.fv - dn.fv) / (2 * H) * (side === 1 ? 1 : 1),
    dToe: (up.toe - dn.toe) / (2 * H),
    dCamber: (up.camber - dn.camber) / (2 * H),
  };
}

/** Kinematic roll center: each contact patch's n-line runs perpendicular to
 *  its velocity under bump (through the front-view IC); the axle roll center
 *  is where the left and right n-lines cross. Fully numeric — valid at any
 *  ride/roll position, which is exactly how OptimumK reports RC migration. */
export function axleChannels(
  geoL: AxleGeometry, geoR: AxleGeometry, params: VehicleParams,
  stL: CornerState, stR: CornerState,
  dzL: number, dzR: number, rack: number,
  isFront: boolean, wheelbase: number,
  /** Skip the ±bump probe solves — every axle channel becomes NaN. */
  skipProbes = false,
): AxleChannels {
  if (skipProbes) {
    return {
      rollCenter: [NaN, NaN], icLeft: null, icRight: null, antiPct: NaN,
      bumpSteerLeft: NaN, bumpSteerRight: NaN, camberGainLeft: NaN, camberGainRight: NaN,
    };
  }
  const L = probeSide(geoL, 1, params, dzL, rack, stL);
  const R = probeSide(geoR, -1, params, dzR, rack, stR);

  // n-line: point cp, direction perpendicular to front-view velocity (vy, 1).
  const d1: [number, number] = [-1, L.vy];
  const d2: [number, number] = [-1, R.vy];
  // Solve cpL + t·d1 = cpR + u·d2 in (y, z).
  const det = d1[0] * -d2[1] - d1[1] * -d2[0];
  let rc: [number, number];
  if (Math.abs(det) < 1e-9) {
    rc = [0, (L.cp[2] + R.cp[2]) / 2]; // parallel n-lines → RC on ground line
  } else {
    const by = R.cp[1] - L.cp[1];
    const bz = R.cp[2] - L.cp[2];
    const t = (by * -d2[1] - bz * -d2[0]) / det;
    rc = [L.cp[1] + t * d1[0], L.cp[2] + t * d1[1]];
  }

  const ic = (p: SideProbe): [number, number] | null => {
    if (Math.abs(p.omega) < 1e-6) return null;
    return [p.cp[1] - 1 / p.omega * 1, p.cp[2] + p.vy / p.omega];
  };
  // IC: y0 = y − v_z/ω, z0 = z + v_y/ω with v_z ≈ 1 per unit bump.
  const icL = Math.abs(L.omega) < 1e-6 ? null
    : ([L.cp[1] - 1 / L.omega, L.cp[2] + L.vy / L.omega] as [number, number]);
  const icR = Math.abs(R.omega) < 1e-6 ? null
    : ([R.cp[1] - 1 / R.omega, R.cp[2] + R.vy / R.omega] as [number, number]);
  void ic;

  // Side-view n-line slope from contact-patch longitudinal velocity.
  const svSlope = -((L.vx + R.vx) / 2);
  const lOverH = wheelbase / Math.max(params.cgHeight, 1e-6);
  const antiPct = isFront
    ? 100 * svSlope * lOverH * params.brakeBiasFront
    : 100 * -svSlope * lOverH;

  return {
    rollCenter: rc,
    icLeft: icL,
    icRight: icR,
    antiPct,
    bumpSteerLeft: L.dToe,
    bumpSteerRight: R.dToe,
    camberGainLeft: L.dCamber,
    camberGainRight: R.dCamber,
  };
}

/** Ackermann percentage from the two front road-wheel steer angles.
 *  100 % = perfect Ackermann (cot δo − cot δi = track/wheelbase). */
export function ackermannPct(
  steerLeftDeg: number, steerRightDeg: number,
  track: number, wheelbase: number,
): number | null {
  const dL = (steerLeftDeg * Math.PI) / 180;
  const dR = (steerRightDeg * Math.PI) / 180;
  if (Math.abs(dL) < 0.5 * (Math.PI / 180) && Math.abs(dR) < 0.5 * (Math.PI / 180)) return null;
  // Turn direction decides inner/outer (+ = left turn ⇒ left wheel inner) —
  // NOT steer magnitude, which flips the labels on anti-Ackermann geometry.
  const left = (dL + dR) / 2 > 0;
  const ai = Math.abs(left ? dL : dR); // inner
  const ao = Math.abs(left ? dR : dL); // outer
  if (ai < 1e-4 || ao < 1e-4) return null;
  return (100 * (1 / Math.tan(ao) - 1 / Math.tan(ai))) / (track / wheelbase);
}
