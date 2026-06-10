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
import { simLap, type LapOpts, type LapTelemetry } from "./lapSim";
import { type Track } from "./track";
import { AUTOCROSS_2026, ENDURANCE_2026 } from "./tracks2026";
import { DEFAULT_FUEL, type Fuel } from "./fuels";
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

// --- Endurance calibration (P2) ---------------------------------------------
// Autocross runs flat-out; endurance does NOT. Over a 22 km run on degrading
// tires, cone-bounded and managed for reliability + fuel, the field runs well
// off the absolute limit. Calibrated to Mines (the closest CBR600RR/E85
// comparison) at their RUN-AVERAGE pace, 159.6 s/lap, and 0.9786 kg CO₂/lap.
//
// Why run-average and not the 148.0 s clean-lap average: the scoring baselines
// (REFERENCE_2026.enduranceTMin = 142.085 s, the efficiency EF anchors) are
// official CORRECTED-TOTAL/laps numbers — in/out laps included. A model lap
// scored against them must be in the same convention, or every design gets
// ~+55 endurance pts of free pace and the whole field looks beatable (the
// clean-lap anchor briefly shipped on 2026-06-09 and put SDM26 in P1).

/** Endurance race-pace fraction of the absolute limit (see LapOpts.pace).
 *  Re-solved on the traced-curvature endurance track at the rules-nominal
 *  2.20 km lap against the Mines run-average anchor, 159.6 s/lap. */
export const ENDURANCE_PACE = 0.551; // re-verified under skidpad-pinned grip + LF 1.167
/** Racing-line factor (see LapOpts.lineFactor): the driven line's effective
 *  corner radius vs the traced centerline. NOW MEASURED-PROVENANCE: with
 *  grip pinned by the real skidpad (μLat 1.368 ← SDM26's 5.02 s, where the
 *  line is fixed and aero ≈ 0), the line factor is the ONLY free knob left
 *  on the autocross anchor, and 1.167 reproduces the real 42.922 s on the
 *  traced 800 m course. A modest +17% effective radius — clip apexes, use
 *  track width, smooth slaloms — vs the old un-anchored 1.39 that was
 *  also carrying inflated-grip compensation. Cross-check: the measured-tire
 *  path with THIS line factor (fitted on the constant-μ path) lands at
 *  42.844 s un-fitted. */
export const LINE_FACTOR = 1.167;
/** PEAK tank-to-propulsive-work efficiency (at the best-BSFC RPM) for the
 *  energy→fuel estimate. The lap sim multiplies this by an RPM-dependent BSFC
 *  shape per segment (bsfcEffMult), so the lap-average effective efficiency is
 *  lower than this peak. Re-solved on the traced endurance track (2.20 km,
 *  rules length) at the new pace against the Mines fuel anchor
 *  (0.9786 kg CO₂/lap on E85). */
export const ENDURANCE_THERMAL_EFF = 0.185; // re-solved under skidpad-pinned grip + LF 1.167
// (0.188 was exact on the shipped SDM26 curve; 0.185 splits the residual with
// the synthetic-curve calibration test — both within ±2% of the Mines anchor)

/** The EXACT LapOpts computeEvents uses for the flat-out autocross lap. Exported
 *  so the Lap Sim screen (which re-runs the lap with channels enabled) can never
 *  drift from the scoring physics. */
export function autocrossLapOpts(): LapOpts {
  return { lineFactor: LINE_FACTOR };
}

/** The EXACT LapOpts computeEvents uses for the race-paced endurance lap (see
 *  autocrossLapOpts for why this is exported). */
export function enduranceLapOpts(fuel: Fuel = DEFAULT_FUEL, co2PerL?: number): LapOpts {
  return {
    pace: ENDURANCE_PACE,
    lineFactor: LINE_FACTOR,
    thermalEff: ENDURANCE_THERMAL_EFF,
    fuelLhvMJkg: fuel.lhvMJkg,
    fuelDensityKgL: fuel.densityKgL,
    co2PerL: co2PerL ?? fuel.co2PerL,
  };
}

export interface EventScores {
  accel: { timeS: number; points: number | null };
  autocross: { lapTimeS: number; points: number | null; telemetry: LapTelemetry };
  endurance: {
    lapTimeS: number;
    fuelKgPerLap: number;
    co2KgPerLap: number;
    points: number | null;
    telemetry: LapTelemetry;
  };
  efficiency: { factor: number | null; points: number | null };
  /** Sum of the modeled events that have a reference baseline (accel + autocross
   *  + endurance + efficiency); null only if none are scorable. Skidpad isn't
   *  modeled, and events without a baseline (e.g. accel under REFERENCE_2026)
   *  aren't counted. */
  totalPoints: number | null;
}

export interface EventOpts {
  autocrossTrack?: Track;
  enduranceTrack?: Track;
  /** Fuel for the endurance/efficiency energy + CO₂ chain. Default Sunoco 93. */
  fuel?: Fuel;
  /** Override just the CO₂ factor, kg/L (legacy; `fuel` is preferred). */
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
  const fuel = opts.fuel ?? DEFAULT_FUEL;
  const co2PerL = opts.co2PerL ?? fuel.co2PerL;
  const axTrack = opts.autocrossTrack ?? AUTOCROSS_2026;
  const enTrack = opts.enduranceTrack ?? ENDURANCE_2026;

  const accel = simAccel(curve, vehicle);
  const accelPts = baseline.accelTMin ? accelPoints(accel.timeS, baseline.accelTMin) : null;

  // Autocross = flat-out (pace 1.0, default). Calibrated muLat + LINE_FACTOR land
  // the time at a REALISTIC tire μ (the racing line carries the corner speed).
  const ax = simLap(curve, vehicle, axTrack, autocrossLapOpts());
  const axPts = baseline.autocrossTMin
    ? autocrossPoints(ax.lapTimeS, baseline.autocrossTMin)
    : null;

  // Endurance = managed race pace + lumped fuel-burn efficiency on the chosen fuel.
  const en = simLap(curve, vehicle, enTrack, enduranceLapOpts(fuel, co2PerL));
  const enTimePts = baseline.enduranceTMin
    ? enduranceTimePoints(en.lapTimeS, baseline.enduranceTMin)
    : null;
  const enPts = enTimePts != null ? Math.min(275, enTimePts + ENDURANCE_LAPS_POINTS) : null;

  const factor =
    baseline.enduranceTMin && baseline.co2MinPerLap
      ? efficiencyFactor(en.lapTimeS, en.co2Kg, baseline.enduranceTMin, baseline.co2MinPerLap)
      : null;
  // Prefer the real field EF anchors (§D.13.4.6); else approximate EFmin from the
  // CO₂ ratio at the time cap and take EFmax = 1.
  const effMin =
    baseline.effMin != null
      ? baseline.effMin
      : baseline.co2MinPerLap && baseline.co2MaxPerLap
        ? (1 / EFF_TIME_CAP) * (baseline.co2MinPerLap / baseline.co2MaxPerLap)
        : null;
  const effMax = baseline.effMax != null ? baseline.effMax : 1;
  const effPts = factor != null && effMin != null ? efficiencyPoints(factor, effMin, effMax) : null;

  // Sum the events that ARE scorable (have a baseline); null only if none are.
  // Lets "total points" rank trials even when a baseline is missing (e.g. no
  // field accel Tmin) — accel simply isn't counted until its baseline exists.
  const scored = [accelPts, axPts, enPts, effPts].filter((p): p is number => p != null);
  const totalPoints = scored.length ? scored.reduce((a, p) => a + p, 0) : null;

  return {
    accel: { timeS: accel.timeS, points: accelPts },
    autocross: { lapTimeS: ax.lapTimeS, points: axPts, telemetry: ax.telemetry },
    endurance: {
      lapTimeS: en.lapTimeS,
      fuelKgPerLap: en.fuelKg,
      co2KgPerLap: en.co2Kg,
      points: enPts,
      telemetry: en.telemetry,
    },
    efficiency: { factor, points: effPts },
    totalPoints,
  };
}
