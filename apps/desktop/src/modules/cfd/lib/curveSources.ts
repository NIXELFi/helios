// Torque-curve sources for the vehicle-performance screens: every completed
// sweep (its per-RPM points) and every optimization study (its best trial's
// stored sweepPoints) is a selectable engine. Shared by the Performance and
// Lap Sim screens so the two dropdowns can never drift.

import { basename } from "./cfdPath";
import type { Study, SweepPoint } from "../state/types";

export interface CurveSource {
  id: string;
  label: string;
  configName: string;
  points: SweepPoint[];
}

/** Sweeps (their per-RPM points) and optimization studies (their best trial's
 *  sweepPoints) are the torque-curve sources. */
export function sourcesFrom(studies: Record<string, Study>): CurveSource[] {
  const out: CurveSource[] = [];
  for (const s of Object.values(studies)) {
    if (s.kind === "sweep" && s.points.length > 0) {
      out.push({
        id: s.id,
        label: `Sweep · ${basename(s.configPath)} · ${s.points.length} rpm`,
        configName: basename(s.configPath),
        points: s.points,
      });
    } else if (s.kind === "optimization") {
      const best =
        s.bestTrialIdx != null
          ? s.trials.find((t) => t.trialIdx === s.bestTrialIdx)
          : undefined;
      const trial =
        best?.sweepPoints && best.sweepPoints.length > 0
          ? best
          : s.trials.find((t) => t.sweepPoints && t.sweepPoints.length > 0);
      if (trial?.sweepPoints && trial.sweepPoints.length > 0) {
        out.push({
          id: s.id,
          label: `Optimization · ${basename(s.configPath)} · best #${trial.trialIdx}`,
          configName: basename(s.configPath),
          points: trial.sweepPoints,
        });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
