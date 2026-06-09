// Gap attribution between two designs: WHY is B faster/slower than A?
//
// Morphs design A into design B one factor at a time and scores each
// intermediate car with the SAME computeEvents the rest of the app uses:
//   A → engine (B's torque curve) → mass → gearing → chassis (everything else)
// Each step's delta is (this step − previous step), so the deltas TELESCOPE:
// they sum exactly to (B − A) on every metric. Order matters for the split
// (interactions land on the later step); engine-first matches how the team
// reasons ("same car, our engine tune" first, hardware identity after).

import type { ReferenceBaseline, VehicleConfig } from "./types";
import type { TorqueCurve } from "./torqueCurve";
import { computeEvents, type EventOpts, type EventScores } from "./events";

export interface CompareDesign {
  label: string;
  curve: TorqueCurve;
  vehicle: VehicleConfig;
}

export type GapStepKey = "baseline" | "engine" | "mass" | "gearing" | "chassis";

export interface GapStep {
  key: GapStepKey;
  /** Human description of what changed at this step. */
  label: string;
  /** Full event scores for the morphed car at this step. */
  events: EventScores;
}

/** VehicleConfig keys that morph at the GEARING step. */
const GEARING_KEYS = [
  "finalDrive",
  "gearRatios",
  "primaryReduction",
  "tireRadiusM",
  "revLimitRpm",
  "shiftRpm",
  "shiftTimeS",
] as const;

/** Decompose the A→B gap into engine / mass / gearing / chassis steps.
 *  steps[0] is A itself; steps[last] is exactly B (every metric telescopes). */
export function attributeGap(
  a: CompareDesign,
  b: CompareDesign,
  baseline: ReferenceBaseline,
  opts: EventOpts = {},
): GapStep[] {
  const steps: GapStep[] = [];
  const score = (curve: TorqueCurve, vehicle: VehicleConfig): EventScores =>
    computeEvents(curve, vehicle, baseline, opts);

  steps.push({ key: "baseline", label: a.label, events: score(a.curve, a.vehicle) });

  // 1. Engine: B's torque curve in A's car.
  steps.push({
    key: "engine",
    label: "engine (torque curve)",
    events: score(b.curve, a.vehicle),
  });

  // 2. Mass: B's mass too.
  const withMass: VehicleConfig = { ...a.vehicle, massKg: b.vehicle.massKg };
  steps.push({ key: "mass", label: "mass", events: score(b.curve, withMass) });

  // 3. Gearing: B's drivetrain (final drive, box, tire radius, rev limit…).
  const withGearing = { ...withMass } as VehicleConfig;
  for (const k of GEARING_KEYS) {
    (withGearing as unknown as Record<string, unknown>)[k] = b.vehicle[k];
  }
  steps.push({ key: "gearing", label: "gearing", events: score(b.curve, withGearing) });

  // 4. Chassis: everything else (aero, grip, geometry, driveline η) → exactly B.
  steps.push({ key: "chassis", label: "chassis (aero/grip/rest)", events: score(b.curve, b.vehicle) });

  return steps;
}

/** Per-step delta of `get(events)` (this − previous). Index 0 is vs nothing
 *  (null). Σ deltas[1..] === get(B) − get(A) by construction. */
export function stepDeltas(
  steps: GapStep[],
  get: (e: EventScores) => number | null,
): (number | null)[] {
  return steps.map((s, i) => {
    if (i === 0) return null;
    const cur = get(s.events);
    const prev = get(steps[i - 1]!.events);
    return cur != null && prev != null ? cur - prev : null;
  });
}
