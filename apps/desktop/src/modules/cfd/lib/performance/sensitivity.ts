// Design-sensitivity analysis: perturb one design lever at a time, re-run the
// FULL event-scoring chain (accel + autocross + endurance + efficiency), and
// report the points delta. This ranks where the next unit of team effort
// pays — the lap sim as a design tool rather than just a scorer.
//
// Perturbations are deliberately "one realistic step" each (5 kg, 5% aero,
// etc.) rather than a uniform %, so the ranking reads as real engineering
// options. Levers are independent one-at-a-time (no interactions).

import type { ReferenceBaseline, VehicleConfig } from "./types";
import type { TorqueCurve } from "./torqueCurve";
import { computeEvents, type EventScores } from "./events";

export interface SensitivityRow {
  key: string;
  /** Human label incl. the step, e.g. "mass −5 kg". */
  label: string;
  events: EventScores;
  /** Δ total points vs baseline (null when no scorable baseline). */
  dPoints: number | null;
  /** Δ autocross lap time (s), negative = faster. */
  dAxS: number;
  /** Δ endurance lap time (s), negative = faster. */
  dEnS: number;
}

interface Lever {
  key: string;
  label: string;
  apply(v: VehicleConfig): VehicleConfig;
}

const LEVERS: Lever[] = [
  {
    key: "mass",
    label: "mass −5 kg",
    apply: (v) => ({ ...v, massKg: v.massKg - 5 }),
  },
  {
    key: "cda",
    label: "drag CdA −5%",
    apply: (v) => ({ ...v, cdaM2: v.cdaM2 * 0.95 }),
  },
  {
    key: "cla",
    label: "downforce ClA +5%",
    apply: (v) => ({ ...v, claM2: v.claM2 * 1.05 }),
  },
  {
    key: "grip",
    label: "tire grip +2.5%",
    apply: (v) =>
      v.tire
        ? {
            ...v,
            tire: {
              ...v.tire,
              scale: v.tire.scale * 1.025,
              scaleLong: (v.tire.scaleLong ?? v.tire.scale) * 1.025,
            },
          }
        : { ...v, muLat: v.muLat * 1.025, muLong: v.muLong * 1.025 },
  },
  {
    key: "driveline",
    label: "driveline η +1 pt",
    apply: (v) => ({ ...v, drivetrainEff: Math.min(0.99, v.drivetrainEff + 0.01) }),
  },
  {
    key: "shift",
    label: "shift time −20 ms",
    apply: (v) => ({ ...v, shiftTimeS: Math.max(0, v.shiftTimeS - 0.02) }),
  },
  {
    key: "cg",
    label: "CG height −10 mm",
    apply: (v) => ({ ...v, cgHeightM: Math.max(0.1, v.cgHeightM - 0.01) }),
  },
];

/** ARB balance levers — only meaningful under the per-axle roll model. */
const ROLL_LEVERS: Lever[] = [
  {
    key: "arbF",
    label: "ARB balance +3% front",
    apply: (v) =>
      v.roll ? { ...v, roll: { ...v.roll, rsdFront: Math.min(0.8, v.roll.rsdFront + 0.03) } } : v,
  },
  {
    key: "arbR",
    label: "ARB balance −3% front",
    apply: (v) =>
      v.roll ? { ...v, roll: { ...v.roll, rsdFront: Math.max(0.2, v.roll.rsdFront - 0.03) } } : v,
  },
];

/** One-at-a-time design sensitivities through the full scoring chain. Rows
 *  come back sorted by |Δpoints| (or |Δ autocross| without a baseline). */
export function designSensitivities(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  baseline: ReferenceBaseline,
): { base: EventScores; rows: SensitivityRow[] } {
  const base = computeEvents(curve, vehicle, baseline);
  const levers = vehicle.roll ? [...LEVERS, ...ROLL_LEVERS] : LEVERS;
  const rows = levers.map((lever) => {
    const ev = computeEvents(curve, lever.apply(vehicle), baseline);
    const dPoints =
      ev.totalPoints != null && base.totalPoints != null
        ? ev.totalPoints - base.totalPoints
        : null;
    return {
      key: lever.key,
      label: lever.label,
      events: ev,
      dPoints,
      dAxS: ev.autocross.lapTimeS - base.autocross.lapTimeS,
      dEnS: ev.endurance.lapTimeS - base.endurance.lapTimeS,
    };
  });
  rows.sort((a, b) =>
    a.dPoints != null && b.dPoints != null
      ? Math.abs(b.dPoints) - Math.abs(a.dPoints)
      : Math.abs(b.dAxS) - Math.abs(a.dAxS),
  );
  return { base, rows };
}
