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
];

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
  };
}

export function trackWidth(a: AxleGeometry): number {
  return 2 * Math.abs(a.wheelCenter[1]);
}

export function wheelbase(car: CarSetup): number {
  return Math.abs(car.front.wheelCenter[0] - car.rear.wheelCenter[0]);
}
