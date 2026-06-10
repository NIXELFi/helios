// Sim-vs-dyno agreement for a sweep: RMSE and mean bias of brake power over
// the overlapping RPM band. This puts the simulator's accuracy claim ON the
// results screen (it previously lived only in physics_findings docs), so
// calibration drift is visible the moment a curve moves.
//
// Convention: bias = mean(sim − dyno). Positive = the sim over-predicts.

import { dynoPowerKw, type DynoPoint } from "../import/importDyno";

export interface DynoComparison {
  /** Dyno points inside the sim's RPM range that produced a power value. */
  n: number;
  rmseKw: number;
  biasKw: number;
  rpmMin: number;
  rpmMax: number;
}

/** Linear interpolation of sim power at `rpm`; null outside the sim range. */
function simPowerAt(sim: { rpm: number; powerKw: number }[], rpm: number): number | null {
  if (sim.length < 2) return null;
  if (rpm < sim[0]!.rpm || rpm > sim[sim.length - 1]!.rpm) return null;
  for (let i = 1; i < sim.length; i++) {
    const a = sim[i - 1]!;
    const b = sim[i]!;
    if (rpm <= b.rpm) {
      const f = b.rpm === a.rpm ? 0 : (rpm - a.rpm) / (b.rpm - a.rpm);
      return a.powerKw + f * (b.powerKw - a.powerKw);
    }
  }
  return null;
}

/** Compare a sim sweep (rpm-sorted) to dyno reference points. Null when there
 *  is no overlap to compare (sim too short, dyno outside the band). */
export function compareDyno(
  sim: { rpm: number; powerKw: number }[],
  dyno: DynoPoint[],
): DynoComparison | null {
  let n = 0;
  let sumSq = 0;
  let sum = 0;
  let rpmMin = Infinity;
  let rpmMax = -Infinity;
  for (const d of dyno) {
    const dp = dynoPowerKw(d);
    if (dp == null) continue;
    const sp = simPowerAt(sim, d.rpm);
    if (sp == null) continue;
    const e = sp - dp;
    n++;
    sumSq += e * e;
    sum += e;
    if (d.rpm < rpmMin) rpmMin = d.rpm;
    if (d.rpm > rpmMax) rpmMax = d.rpm;
  }
  if (n === 0) return null;
  return { n, rmseKw: Math.sqrt(sumSq / n), biasKw: sum / n, rpmMin, rpmMax };
}

/** The calibration bands from physics finding 0028 — the same slices the
 *  solver's dyno-RMSE recalibration was scored on, so on-screen agreement is
 *  directly comparable to the documented calibration numbers. */
export const DYNO_BANDS = [
  { key: "wot", label: "WOT 6k+", lo: 6000, hi: Infinity },
  { key: "peak", label: "peak 7–11.5k", lo: 7000, hi: 11500 },
  { key: "high", label: "high 10.5k+", lo: 10500, hi: Infinity },
] as const;

export interface BandComparison {
  key: string;
  label: string;
  cmp: DynoComparison | null;
}

/** Per-band sim-vs-dyno agreement over the finding-0028 calibration bands. */
export function compareDynoBanded(
  sim: { rpm: number; powerKw: number }[],
  dyno: DynoPoint[],
): BandComparison[] {
  return DYNO_BANDS.map((b) => ({
    key: b.key,
    label: b.label,
    cmp: compareDyno(sim, dyno.filter((d) => d.rpm >= b.lo && d.rpm <= b.hi)),
  }));
}
