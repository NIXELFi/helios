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
  vehicleForCar,
  gearForSpeed,
  totalReduction,
  gearVps,
  topSpeedMps,
} from "./vehicle";
export { FUELS, DEFAULT_FUEL, type Fuel } from "./fuels";
export { parseTirText, distillTir, tirMuLat, tirMuLong, type TirGrip } from "./tir";
export { cachedTrialEvents } from "./eventsCache";
export {
  torqueCurveFromSweep,
  torqueCurveFromDyno,
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
  optimalShiftSpeeds,
  gearAtSpeed,
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
  autocrossLapOpts,
  enduranceLapOpts,
  EVENT_RANK_METRICS,
  POINTS_METRIC_KEYS,
  ENDURANCE_PACE,
  ENDURANCE_THERMAL_EFF,
  type EventScores,
  type EventOpts,
  type EventMetricKey,
} from "./events";
export {
  attributeGap,
  stepDeltas,
  type CompareDesign,
  type GapStep,
  type GapStepKey,
} from "./compare";
export {
  simLap,
  makeGripModel,
  type GripModel,
  type LapResult,
  type LapOpts,
  type LapTelemetry,
  type LapChannels,
  type LimitState,
} from "./lapSim";
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
export {
  trackPlan,
  tightnessOf,
  TIGHTNESS_COLOR,
  parseVisualTrack,
  boundsOf,
  visualCurvatureRadii,
  type TrackPlan,
  type TrackPoint,
  type Tightness,
  type VisualTrack,
  type RawVisualTrack,
  type XY,
} from "./trackGeometry";
export { AUTOCROSS_2026_VISUAL, ENDURANCE_2026_VISUAL } from "./tracksVisual2026";
export {
  sprocketOptions,
  sweepFinalDrive,
  comboLabel,
  type FdOption,
  type FdSweepRow,
  type SprocketCombo,
} from "./fdOptimizer";
