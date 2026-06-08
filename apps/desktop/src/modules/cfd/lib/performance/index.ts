// Public API for the CFD performance / competition-scoring module (frontend).

export type {
  VehicleConfig,
  ReferenceBaseline,
} from "./types";
export {
  SDM26_VEHICLE,
  SDM25_VEHICLE,
  EMPTY_BASELINE,
  REFERENCE_2026,
  carKeyForConfig,
  vehiclePresetForKey,
  totalReduction,
  gearVps,
  topSpeedMps,
} from "./vehicle";
export { FUELS, DEFAULT_FUEL, type Fuel } from "./fuels";
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
export {
  computeEvents,
  EVENT_RANK_METRICS,
  POINTS_METRIC_KEYS,
  ENDURANCE_PACE,
  ENDURANCE_THERMAL_EFF,
  type EventScores,
  type EventOpts,
  type EventMetricKey,
} from "./events";
export { simLap, type LapResult, type LapOpts } from "./lapSim";
export {
  synthesizeAutocross,
  synthesizeEndurance,
  parseTrack,
  discretizeTrack,
  trackLength,
  type Track,
  type TrackSegment,
  type RawTrack,
} from "./track";
export { AUTOCROSS_2026, ENDURANCE_2026 } from "./tracks2026";
