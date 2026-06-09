// Reconstruct a 2D plan-view polyline from a Track for display ONLY.
//
// IMPORTANT: a Track stores corner RADIUS vs distance but NOT turn direction
// (the lap sim is a point mass — direction is irrelevant to it, see track.ts).
// So a faithful course layout is unrecoverable; this walks the segments and
// assigns each corner a direction with a "steer back toward straight" heuristic
// (turn the way that reduces the accumulated heading), which keeps the shape
// compact and never spirals. The result is a SCHEMATIC — corner tightness,
// straight/corner sequence, and lengths are real; left/right and the overall
// outline are approximated. Callers must label it as such.

import { type Track, trackLength } from "./track";

export interface TrackPoint {
  x: number;
  y: number;
  /** Local path radius at this point (Infinity on a straight). */
  radius: number;
  /** Cumulative distance from the start (m). */
  cum: number;
}

export interface TrackPlan {
  points: TrackPoint[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  length: number;
  closed: boolean;
}

/** Walk the track into a plan-view polyline (~`ds`-spaced points). Heading is
 *  integrated segment by segment; corners rotate the heading, the sign chosen
 *  to drive the running heading back toward zero (a compact serpentine). */
export function trackPlan(track: Track, ds = 1.5): TrackPlan {
  let x = 0;
  let y = 0;
  let heading = 0; // radians
  let cum = 0;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  const points: TrackPoint[] = [{ x, y, radius: track.segments[0]?.radius ?? Infinity, cum }];
  const grow = () => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const seg of track.segments) {
    const len = Math.max(0, seg.length);
    if (len === 0) continue;
    const n = Math.max(1, Math.round(len / ds));
    const step = len / n;
    // Straight: radius Infinity → no heading change. Corner: total swept angle
    // = arcLength / radius, signed to reduce |heading| (steer toward straight).
    const isCorner = Number.isFinite(seg.radius) && seg.radius > 0;
    const sign = heading <= 0 ? 1 : -1;
    const dThetaPerStep = isCorner ? (sign * step) / seg.radius : 0;
    for (let k = 0; k < n; k++) {
      heading += dThetaPerStep;
      x += step * Math.cos(heading);
      y += step * Math.sin(heading);
      cum += step;
      points.push({ x, y, radius: seg.radius, cum });
      grow();
    }
  }

  return { points, bbox: { minX, minY, maxX, maxY }, length: trackLength(track), closed: track.closed };
}

/** A corner-tightness bucket for coloring, from a local radius (m). Straights
 *  and very open radii read as "open"; smaller radii escalate to "hairpin". */
export type Tightness = "straight" | "open" | "medium" | "tight" | "hairpin";

export function tightnessOf(radius: number): Tightness {
  if (!Number.isFinite(radius)) return "straight";
  if (radius >= 25) return "open";
  if (radius >= 14) return "medium";
  if (radius >= 8) return "tight";
  return "hairpin";
}

/** Tailwind-free hex for each tightness bucket (cyan straight → hot hairpin),
 *  matching the module's chart palette. */
export const TIGHTNESS_COLOR: Record<Tightness, string> = {
  straight: "#4FC3F7",
  open: "#A5D6A7",
  medium: "#FFC627",
  tight: "#FF8A65",
  hairpin: "#FF5252",
};
