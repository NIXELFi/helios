// The suspension model: hardpoints + vehicle parameters.
//
// Coordinate system — MATCHES the OptimumK points files (inches):
//   X+ forward, Y+ left, Z+ up. Origin: FRONT AXLE on the ground plane
//   (the rear axle sits at negative X, e.g. −60.125 on SDM26). Nothing in
//   the solver assumes an origin; pitch references mid-wheelbase.
// All hardpoints are stored for the LEFT side; the right side is mirrored
// (y → −y) at solve time. Asymmetric setups can come later — the solver
// already treats each corner independently.

import type { V3 } from "./vec";

/** Suspension architecture per axle. "double-wishbone" is the original SDM
 *  layout; "macpherson" replaces the UCA with a strut whose top mount is
 *  chassis-fixed; "multilink5" is five independent chassis↔upright links
 *  (no dedicated LCA/UCA — link 5 is conventionally the toe link). */
export type SuspensionType = "double-wishbone" | "macpherson" | "multilink5";
/** How the spring/damper is actuated. MacPherson axles ignore this (the
 *  strut IS the spring) — see solver.ts. */
export type ActuationType = "pushrod-rocker" | "pullrod-rocker" | "direct-coilover" | "rocker-arm";
export type SpringType = "coil" | "torsion";
/** Third-element / heave-roll decoupling at the axle level (independent of
 *  the ARB). "none" = corner springs only. */
export type DecouplingType = "none" | "third-element" | "heave-roll";
/** Anti-roll bar architecture. "zbar" winds up in heave/warp and is free in
 *  roll — the opposite twist convention from a U-bar. */
export type ArbType = "none" | "ubar" | "zbar";

export interface SuspensionConfig {
  type: SuspensionType;
  actuation: ActuationType;
  spring: SpringType;
  decoupling: DecouplingType;
  arb: ArbType;
}

export function defaultSuspensionConfig(): SuspensionConfig {
  return { type: "double-wishbone", actuation: "pushrod-rocker", spring: "coil", decoupling: "none", arb: "ubar" };
}

/** Display/exchange precision for suspension-point coordinates, by unit.
 *  Only "in" is active today; "mm" lands with the unit system later. */
export const COORD_DECIMALS: Record<"in" | "mm", number> = { in: 3, mm: 2 };
export const ACTIVE_UNIT: "in" | "mm" = "in";

export function roundCoord(v: number): number {
  const f = 10 ** COORD_DECIMALS[ACTIVE_UNIT];
  return Math.round(v * f) / f;
}
export function roundPoint(p: V3): V3 {
  return [roundCoord(p[0]), roundCoord(p[1]), roundCoord(p[2])];
}
export function fmtCoord(v: number): string {
  return v.toFixed(COORD_DECIMALS[ACTIVE_UNIT]);
}

/** Hardpoints for one axle (left side). Double wishbone + toe link +
 *  pushrod-actuated rocker + coilover — the standard FSAE arrangement and the
 *  same skeleton OptimumKinematics uses for its "Double A-Arm" template. */
export interface AxleGeometry {
  /** Lower control arm inboard, forward leg. */
  lcaFront: V3;
  /** Lower control arm inboard, rearward leg. */
  lcaRear: V3;
  /** Lower ball joint (outer). */
  lbj: V3;
  ucaFront: V3;
  ucaRear: V3;
  ubj: V3;
  /** Toe link inboard: steering-rack end (front) or chassis pickup (rear). */
  tieInner: V3;
  /** Toe link outboard (on the upright). */
  tieOuter: V3;
  /** Pushrod outboard end — attached to the LCA (typ.) or the upright. */
  pushLower: V3;
  /** Pushrod inboard end — on the rocker. */
  pushUpper: V3;
  /** Rocker pivot axis, two points. */
  rockerAxis1: V3;
  rockerAxis2: V3;
  /** Coilover: rocker-side eye and chassis-side eye. */
  shockRocker: V3;
  shockChassis: V3;
  /** Wheel center (upright-fixed). */
  wheelCenter: V3;
  /** A second point on the wheel spin axis, outboard of wheelCenter
   *  (upright-fixed). Encodes static camber/toe. */
  wheelAxisOuter: V3;
  /** Where the pushrod picks up: lower A-arm, upper A-arm, or the upright.
   *  (SDM26 runs front actuation off the UPPER arm per the OpK file.) */
  pushrodOn: "lca" | "uca" | "upright";
  /** U-bar / ARB (OpK "U-Bar" section). The droplink runs from a pickup on a
   *  moving body (NSMA_UBarAttPnt — SDM26 hangs it off the rocker) down to
   *  the bar's lever-arm end (UBAR_AttPnt); the arm rotates about a lateral
   *  axis through the chassis pivot (CHAS_PivPnt). */
  ubarNsma: V3;
  ubarArm: V3;
  ubarPivot: V3;
  /** Which body carries the U-bar droplink pickup. */
  ubarOn: "rocker" | "lca" | "uca" | "upright";
  /** Link outside diameters (in) for the clearance study. Fore and aft legs
   *  of each control arm share the arm's diameter. */
  linkOD: LinkOD;

  /** Per-axle suspension architecture: type, actuation, spring, decoupling,
   *  ARB. Front and rear are independent — mixed setups are the point. */
  config: SuspensionConfig;

  // --- MacPherson strut points (config.type === "macpherson") ---
  /** Strut top mount, chassis-fixed. */
  strutTop: V3;
  /** Upright-fixed point on the strut axis, near/above the LBJ. The kingpin
   *  axis for a MacPherson corner is lbj → strutTop (see solver.ts); this
   *  point anchors the strut's own axial/length constraint. */
  strutLower: V3;

  // --- Multi-link points (config.type === "multilink5") --- five
  // independent chassis(In)↔upright(Out) links. By convention link 5 is the
  // toe link (its inner point translates with rack on a steered axle).
  ml1In: V3; ml1Out: V3;
  ml2In: V3; ml2Out: V3;
  ml3In: V3; ml3Out: V3;
  ml4In: V3; ml4Out: V3;
  ml5In: V3; ml5Out: V3;

  // --- Decoupling / third-element pickups (rocker-fixed) --- the heave
  // and roll elements each run from thirdRocker/rollRocker on THIS side's
  // rocker to the MIRRORED point on the opposite side's rocker.
  /** Rocker-fixed pickup for the heave (third) element. */
  thirdRocker: V3;
  /** Rocker-fixed pickup for the roll element ("heave-roll" mode only). */
  rollRocker: V3;
}

export interface LinkOD {
  lca: number;
  uca: number;
  tie: number;
  push: number;
  droplink: number;
  /** Coilover body OD — the shock is checked as a thick segment. */
  shock: number;
}

export const LINK_OD_KEYS: { key: keyof LinkOD; label: string }[] = [
  { key: "lca", label: "LCA legs" },
  { key: "uca", label: "UCA legs" },
  { key: "tie", label: "Toe link" },
  { key: "push", label: "Pushrod" },
  { key: "droplink", label: "U-bar droplink" },
  { key: "shock", label: "Coilover body" },
];

export function defaultLinkOD(): LinkOD {
  return { lca: 0.625, uca: 0.625, tie: 0.5, push: 0.625, droplink: 0.375, shock: 2.0 };
}

/** Hosts a droplink/pushrod pickup can ride on, for the attachments UI. */
export const PUSHROD_HOSTS: { value: AxleGeometry["pushrodOn"]; label: string }[] = [
  { value: "lca", label: "Lower A-arm" },
  { value: "uca", label: "Upper A-arm" },
  { value: "upright", label: "Upright" },
];
export const UBAR_HOSTS: { value: AxleGeometry["ubarOn"]; label: string }[] = [
  { value: "rocker", label: "Rocker" },
  { value: "lca", label: "Lower A-arm" },
  { value: "uca", label: "Upper A-arm" },
  { value: "upright", label: "Upright" },
];

export interface VehicleParams {
  /** Tire loaded radius, in. */
  tireRadius: number;
  tireWidth: number;
  /** Spring rates, lb/in. */
  springRateFront: number;
  springRateRear: number;
  /** CG height above ground, in — used for anti-dive / anti-squat. */
  cgHeight: number;
  /** Fraction of braking force on the front axle (0–1). */
  brakeBiasFront: number;
  /** Coilover length limits, in — explicit hard stops. The solver uses them
   *  to flag bottoming/topping and to compute total travel per corner. */
  coilMinFront: number;
  coilMaxFront: number;
  coilMinRear: number;
  coilMaxRear: number;
  /** Torsion-spring rate, lb·in/deg (config.spring === "torsion"). */
  torsionRateFront: number;
  torsionRateRear: number;
  /** Third-element (heave, decoupled) rate, lb/in at the element. */
  thirdRateFront: number;
  thirdRateRear: number;
  /** Roll-element rate, lb/in at the element ("heave-roll" decoupling). */
  rollRateFront: number;
  rollRateRear: number;
}

export interface CarSetup {
  name: string;
  front: AxleGeometry;
  rear: AxleGeometry;
  params: VehicleParams;
  /** Raw OptimumK-file extras preserved for lossless round-trip (U-bar
   *  points, stiffnesses, steering ratio, raw right-side values, …). */
  opk?: Record<string, unknown> | null;
}

/** Ride/attitude state driven by the UI. Lengths in inches, angles in degrees,
 *  rack travel in inches (+ = rack moves left ⇒ car steers right? No:
 *  + rack = tie rods pushed toward +Y ⇒ left turn for a front-steer rack). */
export interface Pose {
  heave: number; // + up (chassis rises ⇒ wheels droop) — applied as wheel-center Δz = −heave
  rollDeg: number; // + right side down (roll to the right)
  pitchDeg: number; // + nose down
  rack: number; // rack travel, in (+Y)
}

export const STATIC_POSE: Pose = { heave: 0, rollDeg: 0, pitchDeg: 0, rack: 0 };

export type CornerId = "FL" | "FR" | "RL" | "RR";
export const CORNERS: CornerId[] = ["FL", "FR", "RL", "RR"];

/** Plausible defaults for the v0.6.0 additions (MacPherson strut, 5-link,
 *  decoupling pickups), derived near an axle's existing points so a fresh
 *  car is geometrically sane even before anyone edits these hardpoints. */
function defaultNewFields(xf: number): Pick<
  AxleGeometry,
  "config" | "strutTop" | "strutLower" |
  "ml1In" | "ml1Out" | "ml2In" | "ml2Out" | "ml3In" | "ml3Out" | "ml4In" | "ml4Out" | "ml5In" | "ml5Out" |
  "thirdRocker" | "rollRocker"
> {
  return {
    config: defaultSuspensionConfig(),
    // Near the UBJ/LBJ, above the upright — a plausible strut axis.
    strutTop: [xf, 18.5, 22.0],
    strutLower: [xf, 21.5, 10.0],
    // Multi-link defaults mirror the double-wishbone skeleton: 1/2 = LCA
    // fore/aft legs, 3/4 = UCA fore/aft legs, 5 = toe link.
    ml1In: [xf + 5.75, 8.5, 3.4], ml1Out: [xf, 22.6, 4.6],
    ml2In: [xf - 5.75, 8.5, 3.2], ml2Out: [xf, 22.6, 4.6],
    ml3In: [xf + 4.25, 9.5, 8.6], ml3Out: [xf, 21.9, 12.4],
    ml4In: [xf - 4.75, 9.5, 8.4], ml4Out: [xf, 21.9, 12.4],
    ml5In: [xf + 3.65, 8.0, 4.0], ml5Out: [xf + 3.15, 22.0, 4.8],
    // Rocker-fixed pickups for the third/roll decoupling elements — offset
    // in z from the rocker axis so their velocity has a lateral component
    // ALONG the (cross-car) element; a pickup level with the axis would
    // stroke the element by nothing.
    thirdRocker: [xf - 0.25, 9.8, 12.6],
    rollRocker: [xf - 0.5, 9.8, 15.0],
  };
}

/** Default setup: representative FSAE open-wheeler (inches).
 *  60.5" wheelbase, 48"/46" track, 18"-OD tire. Origin at the FRONT AXLE
 *  (OptimumK convention). Replace with the real SDM hardpoints. */
export function defaultCar(): CarSetup {
  const xf = 0; // front axle station — the global origin, like the OpK files
  const front: AxleGeometry = {
    lcaFront: [xf + 5.75, 8.5, 3.4],
    lcaRear: [xf - 5.75, 8.5, 3.2],
    lbj: [xf, 22.6, 4.6],
    ucaFront: [xf + 4.25, 9.5, 8.6],
    ucaRear: [xf - 4.75, 9.5, 8.4],
    ubj: [xf, 21.9, 12.4],
    tieInner: [xf + 3.65, 8.0, 4.0],
    tieOuter: [xf + 3.15, 22.0, 4.8],
    pushLower: [xf + 0.05, 20.5, 5.0],
    pushUpper: [xf - 0.25, 10.5, 14.5],
    rockerAxis1: [xf - 1.25, 9.8, 13.8],
    rockerAxis2: [xf + 0.75, 9.8, 13.8],
    shockRocker: [xf - 0.25, 8.2, 15.6],
    shockChassis: [xf - 0.25, 3.0, 12.0],
    wheelCenter: [xf, 24.0, 9.0],
    wheelAxisOuter: [xf, 26.0, 9.0],
    pushrodOn: "lca",
    ubarNsma: [xf - 0.25, 10.6, 12.8],
    ubarArm: [xf - 0.25, 10.6, 4.0],
    ubarPivot: [xf - 4.25, 10.6, 4.0],
    ubarOn: "rocker",
    linkOD: defaultLinkOD(),
    ...defaultNewFields(xf),
  };
  const xr = -60.5;
  const rear: AxleGeometry = {
    lcaFront: [xr + 5.75, 8.5, 3.4],
    lcaRear: [xr - 5.75, 8.5, 3.2],
    lbj: [xr, 21.6, 4.6],
    ucaFront: [xr + 4.75, 9.5, 8.6],
    ucaRear: [xr - 4.25, 9.5, 8.4],
    ubj: [xr, 20.9, 12.6],
    tieInner: [xr - 3.65, 8.2, 4.2],
    tieOuter: [xr - 3.15, 21.0, 4.9],
    pushLower: [xr - 0.05, 19.5, 5.0],
    pushUpper: [xr + 0.25, 10.5, 14.5],
    rockerAxis1: [xr - 0.75, 9.8, 13.8],
    rockerAxis2: [xr + 1.25, 9.8, 13.8],
    shockRocker: [xr + 0.25, 8.2, 15.6],
    shockChassis: [xr + 0.25, 3.0, 12.0],
    wheelCenter: [xr, 23.0, 9.0],
    wheelAxisOuter: [xr, 25.0, 9.0],
    pushrodOn: "lca",
    ubarNsma: [xr + 0.25, 10.6, 12.8],
    ubarArm: [xr + 0.25, 10.6, 4.0],
    ubarPivot: [xr + 4.25, 10.6, 4.0],
    ubarOn: "rocker",
    linkOD: defaultLinkOD(),
    ...defaultNewFields(xr),
  };
  return {
    name: "SDM-26 baseline",
    front,
    rear,
    params: {
      tireRadius: 9.0,
      tireWidth: 7.0,
      springRateFront: 250,
      springRateRear: 300,
      cgHeight: 11.0,
      brakeBiasFront: 0.6,
      // Static shock length on this geometry is ~6.32" both ends.
      coilMinFront: 5.4,
      coilMaxFront: 7.2,
      coilMinRear: 5.4,
      coilMaxRear: 7.2,
      // ~25 lb·in/deg at the default rocker ratio (~38 deg/in) lands near
      // the coil setup's wheel rate.
      torsionRateFront: 25,
      torsionRateRear: 25,
      thirdRateFront: 200,
      thirdRateRear: 200,
      rollRateFront: 200,
      rollRateRear: 200,
    },
  };
}

/** Editable hardpoint list (label + key), in sensible display order. */
export const HARDPOINT_KEYS: { key: keyof AxleGeometry; label: string }[] = [
  { key: "lcaFront", label: "LCA inboard fwd" },
  { key: "lcaRear", label: "LCA inboard rear" },
  { key: "lbj", label: "LCA outer (LBJ)" },
  { key: "ucaFront", label: "UCA inboard fwd" },
  { key: "ucaRear", label: "UCA inboard rear" },
  { key: "ubj", label: "UCA outer (UBJ)" },
  { key: "tieInner", label: "Toe link inner" },
  { key: "tieOuter", label: "Toe link outer" },
  { key: "pushLower", label: "Pushrod outboard" },
  { key: "pushUpper", label: "Pushrod @ rocker" },
  { key: "rockerAxis1", label: "Rocker axis A" },
  { key: "rockerAxis2", label: "Rocker axis B" },
  { key: "shockRocker", label: "Shock @ rocker" },
  { key: "shockChassis", label: "Shock @ chassis" },
  { key: "wheelCenter", label: "Wheel center" },
  { key: "wheelAxisOuter", label: "Wheel axis outer" },
  { key: "ubarNsma", label: "U-bar pickup (NSMA)" },
  { key: "ubarArm", label: "U-bar arm end" },
  { key: "ubarPivot", label: "U-bar chassis pivot" },
  { key: "strutTop", label: "Strut top mount" },
  { key: "strutLower", label: "Strut lower (upright)" },
  { key: "ml1In", label: "Link 1 inboard" },
  { key: "ml1Out", label: "Link 1 outboard" },
  { key: "ml2In", label: "Link 2 inboard" },
  { key: "ml2Out", label: "Link 2 outboard" },
  { key: "ml3In", label: "Link 3 inboard" },
  { key: "ml3Out", label: "Link 3 outboard" },
  { key: "ml4In", label: "Link 4 inboard" },
  { key: "ml4Out", label: "Link 4 outboard" },
  { key: "ml5In", label: "Link 5 (toe) inboard" },
  { key: "ml5Out", label: "Link 5 (toe) outboard" },
  { key: "thirdRocker", label: "3rd element @ rocker" },
  { key: "rollRocker", label: "Roll element @ rocker" },
];

/** Hardpoint keys relevant per suspension type/actuation — the editor and
 *  3D view filter on these. */
export function relevantHardpoints(g: AxleGeometry): (keyof AxleGeometry)[] {
  const c = g.config;
  const out: (keyof AxleGeometry)[] = [];
  if (c.type === "double-wishbone") {
    out.push("lcaFront", "lcaRear", "lbj", "ucaFront", "ucaRear", "ubj", "tieInner", "tieOuter");
  } else if (c.type === "macpherson") {
    out.push("lcaFront", "lcaRear", "lbj", "strutTop", "strutLower", "tieInner", "tieOuter");
  } else {
    out.push("ml1In", "ml1Out", "ml2In", "ml2Out", "ml3In", "ml3Out", "ml4In", "ml4Out", "ml5In", "ml5Out");
  }
  if (c.type !== "macpherson") {
    if (c.actuation === "direct-coilover") {
      out.push("pushLower", "shockChassis");
    } else if (c.actuation === "rocker-arm") {
      out.push("shockRocker", "shockChassis");
    } else {
      out.push("pushLower", "pushUpper", "rockerAxis1", "rockerAxis2", "shockRocker", "shockChassis");
    }
  }
  if (c.arb !== "none") out.push("ubarNsma", "ubarArm", "ubarPivot");
  if (c.decoupling !== "none") out.push("thirdRocker");
  if (c.decoupling === "heave-roll") out.push("rollRocker");
  out.push("wheelCenter", "wheelAxisOuter");
  return out;
}

export function mirrorPoint(p: V3): V3 {
  return [p[0], -p[1], p[2]];
}

/** Deep-copy an axle with y mirrored — produces the right-side geometry. */
export function mirrorAxle(a: AxleGeometry): AxleGeometry {
  const m = (p: V3) => mirrorPoint(p);
  return {
    lcaFront: m(a.lcaFront),
    lcaRear: m(a.lcaRear),
    lbj: m(a.lbj),
    ucaFront: m(a.ucaFront),
    ucaRear: m(a.ucaRear),
    ubj: m(a.ubj),
    tieInner: m(a.tieInner),
    tieOuter: m(a.tieOuter),
    pushLower: m(a.pushLower),
    pushUpper: m(a.pushUpper),
    rockerAxis1: m(a.rockerAxis1),
    rockerAxis2: m(a.rockerAxis2),
    shockRocker: m(a.shockRocker),
    shockChassis: m(a.shockChassis),
    wheelCenter: m(a.wheelCenter),
    wheelAxisOuter: m(a.wheelAxisOuter),
    pushrodOn: a.pushrodOn,
    ubarNsma: m(a.ubarNsma),
    ubarArm: m(a.ubarArm),
    ubarPivot: m(a.ubarPivot),
    ubarOn: a.ubarOn,
    linkOD: { ...a.linkOD },
    config: { ...a.config },
    strutTop: m(a.strutTop),
    strutLower: m(a.strutLower),
    ml1In: m(a.ml1In), ml1Out: m(a.ml1Out),
    ml2In: m(a.ml2In), ml2Out: m(a.ml2Out),
    ml3In: m(a.ml3In), ml3Out: m(a.ml3Out),
    ml4In: m(a.ml4In), ml4Out: m(a.ml4Out),
    ml5In: m(a.ml5In), ml5Out: m(a.ml5Out),
    thirdRocker: m(a.thirdRocker),
    rollRocker: m(a.rollRocker),
  };
}

export function trackWidth(a: AxleGeometry): number {
  return 2 * Math.abs(a.wheelCenter[1]);
}

export function wheelbase(car: CarSetup): number {
  return Math.abs(car.front.wheelCenter[0] - car.rear.wheelCenter[0]);
}
