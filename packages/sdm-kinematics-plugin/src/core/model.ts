// The suspension model: hardpoints + vehicle parameters.
//
// Coordinate system (SDM / SAE-style, inches):
//   X+ forward, Y+ left, Z+ up. Origin: mid-wheelbase on the ground plane.
// All hardpoints are stored for the LEFT side; the right side is mirrored
// (y → −y) at solve time. Asymmetric setups can come later — the solver
// already treats each corner independently.

import type { V3 } from "./vec";

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
  /** Where the pushrod picks up: "lca" or "upright". */
  pushrodOn: "lca" | "upright";
}

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
 *  60.5" wheelbase, 48"/46" track, 18"-OD tire. Replace with the real SDM
 *  hardpoints from the vehicle-dynamics master sheet. */
export function defaultCar(): CarSetup {
  const xf = 30.25; // front axle station (origin at mid-wheelbase)
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
  };
  const xr = -30.25;
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
  };
}

export function trackWidth(a: AxleGeometry): number {
  return 2 * Math.abs(a.wheelCenter[1]);
}

export function wheelbase(car: CarSetup): number {
  return Math.abs(car.front.wheelCenter[0] - car.rear.wheelCenter[0]);
}
