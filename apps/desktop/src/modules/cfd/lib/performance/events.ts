// FSAE dynamic-event scores for one engine torque curve: runs the accel sim and
// the autocross + endurance lap sims, then projects §D.9–D.13 points against a
// reference baseline (last year's field). Physical metrics are always returned;
// `points` fields are null until the matching baseline value is supplied.
//
// This is the single entry point used by BOTH the Performance screen and the
// optimizer re-rank, so a config scores identically wherever it's shown.

import type { ReferenceBaseline, VehicleConfig } from "./types";
import type { TorqueCurve } from "./torqueCurve";
import { simAccel } from "./accel";
import { simLap } from "./lapSim";
import { synthesizeAutocross, synthesizeEndurance, type Track } from "./track";
import {
  accelPoints,
  autocrossPoints,
  enduranceTimePoints,
  efficiencyFactor,
  efficiencyPoints,
} from "./points";

/** Laps score for completing the endurance event (§D.12.13.3); the sim assumes
 *  full completion. */
const ENDURANCE_LAPS_POINTS = 25;
/** Eligibility time cap factor (§D.13.3.1): 1.45× the fastest lap. */
const EFF_TIME_CAP = 1.45;

export interface EventScores {
  accel: { timeS: number; points: number | null };
  autocross: { lapTimeS: number; points: number | null };
  endurance: {
    lapTimeS: number;
    fuelKgPerLap: number;
    co2KgPerLap: number;
    points: number | null;
  };
  efficiency: { factor: number | null; points: number | null };
  /** Sum of available modeled-event points (accel + autocross + endurance +
   *  efficiency); null unless every baseline is present. Skidpad isn't modeled. */
  totalPoints: number | null;
}

export interface EventOpts {
  autocrossTrack?: Track;
  enduranceTrack?: Track;
  /** Fuel CO₂ factor, kg/L (gasoline 2.31, E85 1.65). Default gasoline. */
  co2PerL?: number;
}

export type EventMetricKey =
  | "accelTime"
  | "autocrossTime"
  | "enduranceTime"
  | "endurancePts"
  | "efficiencyPts"
  | "totalPts";

/** Event metrics usable as a results ranking dimension / optimization objective.
 *  Shared by the optimizer screen (ranking) and the setup modal (picker) so the
 *  two can't drift. `get` reads the value out of an EventScores; `lowerBetter`
 *  sets the sort sense; `fmt` formats it for display. */
export const EVENT_RANK_METRICS: {
  key: EventMetricKey;
  label: string;
  lowerBetter: boolean;
  fmt: (n: number) => string;
  get: (e: EventScores) => number | null;
}[] = [
  { key: "accelTime", label: "accel (s)", lowerBetter: true, fmt: (n) => n.toFixed(3), get: (e) => e.accel.timeS },
  { key: "autocrossTime", label: "autox (s)", lowerBetter: true, fmt: (n) => n.toFixed(2), get: (e) => e.autocross.lapTimeS },
  { key: "enduranceTime", label: "enduro (s/lap)", lowerBetter: true, fmt: (n) => n.toFixed(2), get: (e) => e.endurance.lapTimeS },
  { key: "endurancePts", label: "enduro pts", lowerBetter: false, fmt: (n) => n.toFixed(1), get: (e) => e.endurance.points },
  { key: "efficiencyPts", label: "effic pts", lowerBetter: false, fmt: (n) => n.toFixed(1), get: (e) => e.efficiency.points },
  { key: "totalPts", label: "total pts", lowerBetter: false, fmt: (n) => n.toFixed(1), get: (e) => e.totalPoints },
];

/** Event keys whose value is FSAE points (need a reference baseline to rank). */
export const POINTS_METRIC_KEYS: EventMetricKey[] = ["endurancePts", "efficiencyPts", "totalPts"];

export function computeEvents(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  baseline: ReferenceBaseline,
  opts: EventOpts = {},
): EventScores {
  const co2PerL = opts.co2PerL ?? 2.31;
  const axTrack = opts.autocrossTrack ?? synthesizeAutocross();
  const enTrack = opts.enduranceTrack ?? synthesizeEndurance();

  const accel = simAccel(curve, vehicle);
  const accelPts = baseline.accelTMin ? accelPoints(accel.timeS, baseline.accelTMin) : null;

  const ax = simLap(curve, vehicle, axTrack);
  const axPts = baseline.autocrossTMin
    ? autocrossPoints(ax.lapTimeS, baseline.autocrossTMin)
    : null;

  const en = simLap(curve, vehicle, enTrack, { co2PerL });
  const enTimePts = baseline.enduranceTMin
    ? enduranceTimePoints(en.lapTimeS, baseline.enduranceTMin)
    : null;
  const enPts = enTimePts != null ? Math.min(275, enTimePts + ENDURANCE_LAPS_POINTS) : null;

  const factor =
    baseline.enduranceTMin && baseline.co2MinPerLap
      ? efficiencyFactor(en.lapTimeS, en.co2Kg, baseline.enduranceTMin, baseline.co2MinPerLap)
      : null;
  const effMin =
    baseline.co2MinPerLap && baseline.co2MaxPerLap
      ? (1 / EFF_TIME_CAP) * (baseline.co2MinPerLap / baseline.co2MaxPerLap)
      : null;
  const effPts = factor != null && effMin != null ? efficiencyPoints(factor, effMin, 1) : null;

  const parts = [accelPts, axPts, enPts, effPts];
  const totalPoints = parts.every((p) => p != null)
    ? parts.reduce((a, p) => a + (p as number), 0)
    : null;

  return {
    accel: { timeS: accel.timeS, points: accelPts },
    autocross: { lapTimeS: ax.lapTimeS, points: axPts },
    endurance: {
      lapTimeS: en.lapTimeS,
      fuelKgPerLap: en.fuelKg,
      co2KgPerLap: en.co2Kg,
      points: enPts,
    },
    efficiency: { factor, points: effPts },
    totalPoints,
  };
}
