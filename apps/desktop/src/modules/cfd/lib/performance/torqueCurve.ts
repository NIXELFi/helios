// A torque curve is the engine's brake torque vs RPM — extracted from a sweep's
// per-RPM points (or an optimization trial's sweepPoints). Everything downstream
// (tractive map, acceleration, skidpad) reads torque through `torqueAtRpm`.

import type { SweepPoint } from "../../state/types";

export interface TorquePoint {
  rpm: number;
  torqueNm: number;
}

/** Ascending-by-rpm list of (rpm, brake torque). */
export type TorqueCurve = TorquePoint[];

/** Build a torque curve from sweep points (brake torque of each RPM's last
 *  converged cycle), dropping non-finite entries and sorting by RPM. */
export function torqueCurveFromSweep(points: SweepPoint[]): TorqueCurve {
  return points
    .map((p) => ({ rpm: p.rpm, torqueNm: p.lastCycle.brakeTorqueNm }))
    .filter((p) => Number.isFinite(p.rpm) && Number.isFinite(p.torqueNm))
    .sort((a, b) => a.rpm - b.rpm);
}

/** Linear-interpolated torque at `rpm`. Clamps (holds flat) below the first and
 *  above the last sampled RPM — the rev-limit cutoff is enforced by the caller,
 *  not here. Empty curve → 0. */
export function torqueAtRpm(curve: TorqueCurve, rpm: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  const first = curve[0]!;
  if (rpm <= first.rpm) return first.torqueNm;
  const last = curve[n - 1]!;
  if (rpm >= last.rpm) return last.torqueNm;
  for (let i = 1; i < n; i++) {
    const b = curve[i]!;
    if (rpm <= b.rpm) {
      const a = curve[i - 1]!;
      const span = b.rpm - a.rpm;
      if (span <= 0) return b.torqueNm;
      const t = (rpm - a.rpm) / span;
      return a.torqueNm + t * (b.torqueNm - a.torqueNm);
    }
  }
  return last.torqueNm;
}

/** Peak torque point on the curve (for chart annotation). */
export function peakTorque(curve: TorqueCurve): TorquePoint | null {
  let best: TorquePoint | null = null;
  for (const p of curve) if (!best || p.torqueNm > best.torqueNm) best = p;
  return best;
}
