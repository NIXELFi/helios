// Pure analytics for sweep studies — peaks, powerband width, summary band.
//
// All functions are defensive against unsorted / sparse points and never throw
// on degenerate input. No React / Tauri imports.

import type { SweepPoint } from "../../state/types";

export interface PeakInfo {
  /** rpm of the sampled maximum. */
  rpm: number;
  /** sampled maximum value. */
  value: number;
  /** rpm of the parabolic-vertex estimate (== rpm at edges / <3 points). */
  rpmInterp: number;
  /** value of the parabolic-vertex estimate (== value at edges / <3 points). */
  valueInterp: number;
}

// Sort a copy by rpm so callers may pass points in any order.
function sortedByRpm(points: SweepPoint[]): SweepPoint[] {
  return [...points].sort((a, b) => a.rpm - b.rpm);
}

/** Peak of an accessor over the sweep, with parabolic-vertex interpolation.
 *
 *  Finds the sampled max, then — when that max is an INTERIOR point and there
 *  are ≥3 points — fits a parabola through the (rpm,value) triple around it and
 *  reports the vertex, clamped into the [left, right] neighbor rpm window so a
 *  flat/ill-conditioned fit can't shoot the estimate outside the bracket.
 *  Edge maxima and <3-point sweeps fall back to the sampled point. Returns null
 *  when no point yields a finite value. */
export function peakOf(
  points: SweepPoint[],
  get: (p: SweepPoint) => number,
): PeakInfo | null {
  const pts = sortedByRpm(points).filter((p) => Number.isFinite(get(p)));
  if (pts.length === 0) return null;

  // Sampled argmax.
  let maxIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    if (get(pts[i]!) > get(pts[maxIdx]!)) maxIdx = i;
  }
  const peakPt = pts[maxIdx]!;
  const rpm = peakPt.rpm;
  const value = get(peakPt);

  // Interior + ≥3 points → parabolic vertex through the neighbor triple.
  if (pts.length >= 3 && maxIdx > 0 && maxIdx < pts.length - 1) {
    const left = pts[maxIdx - 1]!;
    const mid = peakPt;
    const right = pts[maxIdx + 1]!;
    const x0 = left.rpm, y0 = get(left);
    const x1 = mid.rpm, y1 = get(mid);
    const x2 = right.rpm, y2 = get(right);
    // Vertex of the parabola through three points (Lagrange form derivative).
    const denom = (x0 - x1) * (x0 - x2) * (x1 - x2);
    if (denom !== 0) {
      const a =
        (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denom;
      const b =
        (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) /
        denom;
      if (a < 0) {
        // Concave-down → real maximum at vertex x = -b/2a.
        let vx = -b / (2 * a);
        // Clamp into the neighbor rpm window.
        if (vx < x0) vx = x0;
        if (vx > x2) vx = x2;
        const vy = a * vx * vx + b * vx + (y1 - a * x1 * x1 - b * x1);
        return { rpm, value, rpmInterp: vx, valueInterp: vy };
      }
    }
  }

  // Edge / <3 points / degenerate fit → sampled point is the estimate.
  return { rpm, value, rpmInterp: rpm, valueInterp: value };
}

/** Width of the rpm band where brakePowerKW ≥ frac × peak power.
 *
 *  Crossings are linearly interpolated against the sampled curve so the band
 *  edges land between points. Returns null with <2 points. */
export function powerbandWidth(
  points: SweepPoint[],
  frac = 0.95,
): { fromRpm: number; toRpm: number; widthRpm: number } | null {
  const pts = sortedByRpm(points).filter((p) =>
    Number.isFinite(p.lastCycle.brakePowerKW),
  );
  if (pts.length < 2) return null;

  const power = (p: SweepPoint) => p.lastCycle.brakePowerKW;
  const peak = Math.max(...pts.map(power));
  const threshold = frac * peak;

  // Find first rpm (scanning up) where the curve reaches the threshold, and
  // the last rpm (scanning down). Interpolate the exact crossing on the
  // straddling segment; if an endpoint is already above threshold, use it.
  let fromRpm: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    if (power(pts[i]!) >= threshold) {
      if (i === 0) {
        fromRpm = pts[0]!.rpm;
      } else {
        const prev = pts[i - 1]!;
        const cur = pts[i]!;
        const t = (threshold - power(prev)) / (power(cur) - power(prev));
        fromRpm = prev.rpm + t * (cur.rpm - prev.rpm);
      }
      break;
    }
  }

  let toRpm: number | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (power(pts[i]!) >= threshold) {
      if (i === pts.length - 1) {
        toRpm = pts[pts.length - 1]!.rpm;
      } else {
        const cur = pts[i]!;
        const next = pts[i + 1]!;
        const t = (threshold - power(cur)) / (power(next) - power(cur));
        toRpm = cur.rpm + t * (next.rpm - cur.rpm);
      }
      break;
    }
  }

  if (fromRpm === null || toRpm === null) return null;
  return { fromRpm, toRpm, widthRpm: toRpm - fromRpm };
}

export interface SweepSummary {
  nPoints: number;
  peakPower: PeakInfo | null;
  peakTorque: PeakInfo | null;
  peakVe: PeakInfo | null;
  powerband: ReturnType<typeof powerbandWidth>;
  /** Max knockIntegral across points; null when no point carries one. */
  maxKnockIntegral: number | null;
}

/** Roll a sweep up into the summary-band values. Sorts defensively. */
export function summarizeSweep(points: SweepPoint[]): SweepSummary {
  const pts = sortedByRpm(points);
  const knocks = pts
    .map((p) => p.lastCycle.knockIntegral)
    .filter((v): v is number => v !== undefined && Number.isFinite(v));
  return {
    nPoints: pts.length,
    peakPower: peakOf(pts, (p) => p.lastCycle.brakePowerKW),
    peakTorque: peakOf(pts, (p) => p.lastCycle.brakeTorqueNm),
    peakVe: peakOf(pts, (p) => p.lastCycle.veAtm),
    powerband: powerbandWidth(pts),
    maxKnockIntegral: knocks.length > 0 ? Math.max(...knocks) : null,
  };
}
