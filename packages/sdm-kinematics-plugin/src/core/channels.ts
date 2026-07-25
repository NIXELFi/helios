// Output channels — the OptimumKinematics catalogue, computed from solved
// corner states. Sign conventions (SAE, X+ fwd / Y+ left / Z+ up):
//   camber   − = top of tire leans inboard
//   toe      + = toe-in
//   caster   + = top of kingpin axis leans rearward
//   KPI      + = top of kingpin axis leans inboard
//   trail    + = contact patch behind the steering-axis ground intercept
//   scrub    + = contact patch outboard of the steering-axis ground intercept
//   steer    + = wheel steered left

import { type V3, sub, add, scale, unit, dot, cross, deg, dist } from "./vec";
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
  /** Lateral tire scrub: contact-patch y-displacement from static, + = the
   *  patch has walked outboard. */
  lateralScrub: number;
  contactPatch: V3;
  wheelAxis: V3; // unit, outboard-pointing
  shockLength: number;
  /** Installation ratio dShock/dWheel (in/in) and resulting wheel rate. */
  installRatio: number;
  wheelRate: number;
  /** Remaining wheel travel (in) until the coilover hits its min/max length:
   *  bump direction, droop direction, and the corner's total travel span. */
  travelBump: number;
  travelDroop: number;
  travelTotal: number;
}

/** Wheel travel (in) from the current position until the shock length hits
 *  `target`, searching in direction `dir` (±1). Secant on the corner solver;
 *  capped at 6" (returned when the limit is unreachable). */
function travelToShockLimit(
  geo: AxleGeometry, dz0: number, rack: number, dir: 1 | -1,
  target: number, L0: number, rate: number, st: CornerState,
): number {
  const CAP = 6;
  if (!Number.isFinite(rate) || Math.abs(rate) < 1e-4) return CAP;
  let dz = (target - L0) / rate;
  if (dz * dir <= 0) return 0; // already at/past this limit
  dz = Math.min(Math.abs(dz), CAP) * dir;
  let prevDz = 0;
  let prevF = L0 - target;
  let best = Math.abs(dz);
  for (let i = 0; i < 12; i++) {
    const s = solveCorner({ geo, dz: dz0 + dz, rack, guessPose: st.poseU, needSteerAxis: false });
    if (!s.ok) {
      // Mechanical lock before the shock limit — back off toward it.
      dz *= 0.7;
      best = Math.abs(dz);
      continue;
    }
    const f = s.shockLength - target;
    best = Math.abs(dz);
    if (Math.abs(f) < 1e-3) return best;
    const denom = f - prevF;
    let next = Math.abs(denom) > 1e-9 ? dz - (f * (dz - prevDz)) / denom : dz * 0.9;
    prevDz = dz;
    prevF = f;
    if (next * dir <= 0) next = dz * 0.5;
    dz = Math.min(Math.abs(next), CAP) * dir;
  }
  return Math.min(best, CAP);
}

export function cornerChannels(
  geo: AxleGeometry,
  st: CornerState,
  side: Side,
  params: VehicleParams,
  springRate: number,
  dz: number,
  rack: number,
  isFront: boolean,
  /** Skip the ±bump probe solves (installation ratio / wheel rate / travel
   *  become NaN). The optimizer uses this to evaluate cheap channels fast. */
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

  // Lateral tire scrub vs the static contact patch (closed form — the static
  // patch comes straight from the stored geometry, no solve needed).
  const aS = (() => {
    let v = unit(sub(geo.wheelAxisOuter, geo.wheelCenter));
    if (v[1] * side < 0) v = scale(v, -1);
    return v;
  })();
  const wS: V3 = unit([-aS[0] * aS[2], -aS[1] * aS[2], 1 - aS[2] * aS[2]]);
  const cpStatic = sub(geo.wheelCenter, scale(wS, params.tireRadius));
  const lateralScrub = side * (contactPatch[1] - cpStatic[1]);

  // Installation ratio + travel to the coilover stops, via probe solves.
  let installRatio = NaN;
  let wheelRate = NaN;
  let travelBump = NaN;
  let travelDroop = NaN;
  let travelTotal = NaN;
  if (!skipProbes) {
    const H = 0.05;
    const up = solveCorner({ geo, dz: dz + H, rack, guessPose: st.poseU, needSteerAxis: false });
    const dn = solveCorner({ geo, dz: dz - H, rack, guessPose: st.poseU, needSteerAxis: false });
    const rate = (up.shockLength - dn.shockLength) / (2 * H); // signed dShock/dWheel
    if (geo.config.spring === "torsion") {
      // Torsion bar on the rocker shaft: WR = kT[lb·in/rad] · (dθ/dz)².
      // installRatio reports the rocker rate in deg/in for torsion setups.
      const dThetaRad = (up.rockerAngle - dn.rockerAngle) / (2 * H);
      const kT = isFront ? params.torsionRateFront : params.torsionRateRear;
      installRatio = Math.abs(deg(dThetaRad));
      wheelRate = kT * (180 / Math.PI) * dThetaRad * dThetaRad;
    } else {
      installRatio = Math.abs(rate);
      wheelRate = springRate * rate * rate;
    }

    const coilMin = isFront ? params.coilMinFront : params.coilMinRear;
    const coilMax = isFront ? params.coilMaxFront : params.coilMaxRear;
    const L0 = st.shockLength;
    // Moving in bump, the shock walks toward whichever stop the rate says.
    const bumpTarget = rate < 0 ? coilMin : coilMax;
    const droopTarget = rate < 0 ? coilMax : coilMin;
    travelBump = travelToShockLimit(geo, dz, rack, 1, bumpTarget, L0, rate, st);
    travelDroop = travelToShockLimit(geo, dz, rack, -1, droopTarget, L0, rate, st);
    travelTotal = travelBump + travelDroop;
  }

  return {
    camber, toe, steer, caster, kpi, mechTrail, scrub, lateralScrub,
    contactPatch, wheelAxis: a,
    shockLength: st.shockLength,
    installRatio,
    wheelRate,
    travelBump, travelDroop, travelTotal,
  };
}

export interface AxleChannels {
  /** Kinematic roll center in the front view (y, z), in. */
  rollCenter: [number, number];
  /** Front-view instant centers per side (y, z) — null when at infinity. */
  icLeft: [number, number] | null;
  icRight: [number, number] | null;
  /** BRAKING anti, %: anti-dive on the front axle, anti-lift on the rear.
   *  Outboard brakes ⇒ the braking torque is reacted by the links, so the
   *  side-view line runs from the CONTACT PATCH to the side-view IC. Scaled
   *  by this axle's share of the braking force (bias front / 1−bias rear),
   *  which is why the front number tracks brake bias and the rear one
   *  moves the opposite way. */
  antiBrakePct: number;
  /** ACCELERATION anti, %: anti-squat on the (driven) rear axle. RWD with an
   *  inboard diff ⇒ drive torque goes to the chassis through the halfshafts,
   *  so the line runs from the WHEEL CENTER, not the contact patch — the same
   *  assumption the link-force calculator makes. An undriven, unbraked front
   *  axle carries no longitudinal tire force and therefore has no geometric
   *  anti at all under power: it is exactly 0, not a small number. */
  antiAccelPct: number;
  /** Bump steer at the current position, deg/in. */
  bumpSteerLeft: number;
  bumpSteerRight: number;
  /** Camber gain, deg/in of bump. */
  camberGainLeft: number;
  camberGainRight: number;
  /** ARB twist ratio: lever-arm rotation per inch of single-wheel bump,
   *  deg/in. */
  arbTwistRatioLeft: number;
  arbTwistRatioRight: number;
  /** ARB motion ratio: wheel travel per inch of droplink-pickup travel
   *  (measured along the droplink), in/in. */
  arbMotionRatioLeft: number;
  arbMotionRatioRight: number;
  /** ARB installation ratio: droplink-pickup travel per inch of wheel
   *  travel — the inverse of the motion ratio. */
  arbInstallRatioLeft: number;
  arbInstallRatioRight: number;
  /** Side-view n-line slope dz/dx at the contact patch (L/R average) — the
   *  force calculator intersects front & rear lines for the pitch center. */
  svSlope: number;
  /** Decoupled wheel rates, lb/in at the wheel — the axle's effective rate
   *  in pure-heave and pure-roll wheel motion (config.decoupling !== "none";
   *  NaN otherwise). third-element: corner coils + shared heave element in
   *  heave, corner coils only in roll. heave-roll: heave element only in
   *  heave, roll element only in roll (corner units are dampers). */
  wheelRateHeave: number;
  wheelRateRoll: number;
}

/** Element-length rates for the decoupling springs, probed with both wheels
 *  moving together (heave) or opposite (roll). Elements run pickup-to-pickup
 *  across the car, so their energy is shared by two wheels (the ½ factors). */
function decoupledRates(
  geoL: AxleGeometry, geoR: AxleGeometry, params: VehicleParams,
  stL: CornerState, stR: CornerState, dzL: number, dzR: number, rack: number,
  isFront: boolean, springRate: number,
): { heave: number; roll: number } {
  const cfg = geoL.config;
  if (cfg.decoupling === "none") return { heave: NaN, roll: NaN };
  const H = 0.05;
  const solveAt = (dL: number, dR: number): [CornerState, CornerState] => [
    solveCorner({ geo: geoL, dz: dzL + dL, rack, guessPose: stL.poseU, needSteerAxis: false }),
    solveCorner({ geo: geoR, dz: dzR + dR, rack, guessPose: stR.poseU, needSteerAxis: false }),
  ];
  // Heave element: a straight cross-car spring — its stroke is the geometric
  // length change (responds to the SYMMETRIC pickup motion). Roll element: a
  // heave-roll mechanism (T-bar / crossed lever) extracts the ANTISYMMETRIC
  // component instead, so its stroke is the DIFFERENCE of the two pickups'
  // inboard displacements — zero in pure heave by construction.
  const inboard = (side: "L" | "R", st: CornerState, staticP: V3): number =>
    side === "L" ? -(st.rollRocker[1] - staticP[1]) : st.rollRocker[1] - staticP[1];
  const elementRates = (mode: "heave" | "roll") => {
    const sgn = mode === "heave" ? 1 : -1;
    const [upL, upR] = solveAt(H, sgn * H);
    const [dnL, dnR] = solveAt(-H, -sgn * H);
    // Per inch of (single) wheel motion in this mode.
    const dThird = (dist(upL.thirdRocker, upR.thirdRocker) - dist(dnL.thirdRocker, dnR.thirdRocker)) / (2 * H);
    const rollStroke = (l: CornerState, r: CornerState) =>
      inboard("L", l, geoL.rollRocker) - inboard("R", r, geoR.rollRocker);
    const dRoll = (rollStroke(upL, upR) - rollStroke(dnL, dnR)) / (2 * H);
    const dCorner = (upL.shockLength - dnL.shockLength) / (2 * H);
    return { dThird, dRoll, dCorner };
  };
  const kThird = isFront ? params.thirdRateFront : params.thirdRateRear;
  const kRoll = isFront ? params.rollRateFront : params.rollRateRear;
  const h = elementRates("heave");
  const r = elementRates("roll");
  if (cfg.decoupling === "third-element") {
    return {
      heave: springRate * h.dCorner * h.dCorner + (kThird * h.dThird * h.dThird) / 2,
      roll: springRate * r.dCorner * r.dCorner + (kThird * r.dThird * r.dThird) / 2,
    };
  }
  // heave-roll: corner units are dampers; springs are the two elements.
  return {
    heave: (kThird * h.dThird * h.dThird) / 2 + (kRoll * h.dRoll * h.dRoll) / 2,
    roll: (kThird * r.dThird * r.dThird) / 2 + (kRoll * r.dRoll * r.dRoll) / 2,
  };
}

interface SideProbe {
  cp: V3;
  vy: number; // d(cp_y)/d(bump)
  vx: number; // d(cp_x)/d(bump)
  /** d(wheelCenter_x)/d(bump) — the side-view line for loads whose TORQUE is
   *  reacted by the chassis rather than the links (inboard diff/halfshafts,
   *  inboard brakes). Those act at the wheel center, not the contact patch. */
  wcVx: number;
  omega: number; // front-view upright rotation, rad per in of bump
  dToe: number;
  dCamber: number;
  /** d(U-bar arm angle)/d(bump), deg/in — NaN when the axle has no U-bar. */
  dArb: number;
  /** d(droplink-pickup travel along the droplink)/d(bump), in/in. */
  dLink: number;
}

function probeSide(
  geo: AxleGeometry, side: Side, params: VehicleParams,
  dz: number, rack: number, st: CornerState,
): SideProbe {
  const H = 0.05;
  const solveAt = (d: number) => solveCorner({ geo, dz: d, rack, guessPose: st.poseU, needSteerAxis: false });
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
  const upState = solveAt(dz + H);
  const dnState = solveAt(dz - H);
  const up = chanAt(upState);
  const dn = chanAt(dnState);
  // Droplink drive: pickup displacement projected onto the droplink axis —
  // the component that actually strokes the bar.
  const linkDir = unit(sub(st.ubarArm, st.ubarNsma));
  const dLink = dot(sub(upState.ubarNsma, dnState.ubarNsma), linkDir) / (2 * H);
  return {
    cp: cur.cp,
    vy: (up.cp[1] - dn.cp[1]) / (2 * H),
    vx: (up.cp[0] - dn.cp[0]) / (2 * H),
    wcVx: (upState.wheelCenter[0] - dnState.wheelCenter[0]) / (2 * H),
    omega: (up.fv - dn.fv) / (2 * H) * (side === 1 ? 1 : 1),
    dToe: (up.toe - dn.toe) / (2 * H),
    dCamber: (up.camber - dn.camber) / (2 * H),
    dArb: deg(upState.ubarAngle - dnState.ubarAngle) / (2 * H),
    dLink,
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
      rollCenter: [NaN, NaN], icLeft: null, icRight: null,
      antiBrakePct: NaN, antiAccelPct: NaN,
      bumpSteerLeft: NaN, bumpSteerRight: NaN, camberGainLeft: NaN, camberGainRight: NaN,
      arbTwistRatioLeft: NaN, arbTwistRatioRight: NaN,
      arbMotionRatioLeft: NaN, arbMotionRatioRight: NaN,
      arbInstallRatioLeft: NaN, arbInstallRatioRight: NaN,
      svSlope: NaN,
      wheelRateHeave: NaN, wheelRateRoll: NaN,
    };
  }
  const L = probeSide(geoL, 1, params, dzL, rack, stL);
  const R = probeSide(geoR, -1, params, dzR, rack, stR);
  const springRate = isFront ? params.springRateFront : params.springRateRear;
  const dec = decoupledRates(geoL, geoR, params, stL, stR, dzL, dzR, rack, isFront, springRate);

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

  // Side-view n-line slopes: the contact-patch line (loads whose torque the
  // LINKS react — outboard brakes) and the wheel-center line (loads whose
  // torque the CHASSIS reacts — inboard diff/halfshafts).
  const svSlope = -((L.vx + R.vx) / 2);
  const svSlopeWc = -((L.wcVx + R.wcVx) / 2);
  const lOverH = wheelbase / Math.max(params.cgHeight, 1e-6);

  // 100 % anti = the side-view line aimed at the CG height over the
  // wheelbase, so tanθ normalized by h/L is the anti fraction. Each axle
  // only develops anti in proportion to the longitudinal force it carries.
  // Rear slope is negated: the same tilt that lifts the front under braking
  // pushes the rear down, so both read positive for "resists the motion".
  const brakeShare = isFront ? params.brakeBiasFront : 1 - params.brakeBiasFront;
  const antiBrakePct = (isFront ? svSlope : -svSlope) * lOverH * brakeShare * 100;
  // Under power only the driven axle makes anti, and via the wheel-center
  // line because the diff is chassis-mounted.
  const antiAccelPct = isFront ? 0 : -svSlopeWc * lOverH * 100;

  return {
    rollCenter: rc,
    icLeft: icL,
    icRight: icR,
    antiBrakePct,
    antiAccelPct,
    bumpSteerLeft: L.dToe,
    bumpSteerRight: R.dToe,
    camberGainLeft: L.dCamber,
    camberGainRight: R.dCamber,
    arbTwistRatioLeft: L.dArb,
    arbTwistRatioRight: R.dArb,
    arbInstallRatioLeft: Math.abs(L.dLink),
    arbInstallRatioRight: Math.abs(R.dLink),
    arbMotionRatioLeft: Math.abs(L.dLink) > 1e-4 ? 1 / Math.abs(L.dLink) : NaN,
    arbMotionRatioRight: Math.abs(R.dLink) > 1e-4 ? 1 / Math.abs(R.dLink) : NaN,
    svSlope,
    wheelRateHeave: dec.heave,
    wheelRateRoll: dec.roll,
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
