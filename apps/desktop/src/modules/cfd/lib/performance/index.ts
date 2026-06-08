// Public API for the CFD performance / competition-scoring module (frontend).

export type {
  VehicleConfig,
  ReferenceBaseline,
} from "./types";
export {
  SDM26_VEHICLE,
  SDM25_VEHICLE,
  EMPTY_BASELINE,
  carKeyForConfig,
  vehiclePresetForKey,
  totalReduction,
  gearVps,
  topSpeedMps,
} from "./vehicle";
export {
  torqueCurveFromSweep,
  torqueAtRpm,
  peakTorque,
  type TorqueCurve,
  type TorquePoint,
} from "./torqueCurve";
export {
  G,
  tractiveForceInGear,
  tractiveEnvelope,
  tractionLimit,
  resistanceForce,
  tractiveMap,
  type TractiveMap,
} from "./tractive";
export {
  simAccel,
  type AccelResult,
  type AccelSample,
  type AccelOpts,
  type ShiftPoint,
} from "./accel";
export {
  skidpad,
  SKIDPAD_INNER_RADIUS_M,
  type SkidpadResult,
  type SkidpadGear,
  type SkidpadOpts,
} from "./skidpad";
export {
  accelPoints,
  autocrossPoints,
  enduranceTimePoints,
  efficiencyFactor,
  efficiencyPoints,
} from "./points";
export { computeEvents, type EventScores, type EventOpts } from "./events";
export { simLap, type LapResult, type LapOpts } from "./lapSim";
export {
  synthesizeAutocross,
  synthesizeEndurance,
  discretizeTrack,
  trackLength,
  type Track,
  type TrackSegment,
} from "./track";
