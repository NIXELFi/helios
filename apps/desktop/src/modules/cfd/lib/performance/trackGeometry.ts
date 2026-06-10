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

import { type Track, type TrackSegment, trackLength } from "./track";

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

// --- Visual tracks: true traced planar geometry (display only) -------------
// Unlike the radius-segment Track (which the lap sim integrates and which omits
// turn direction), a VisualTrack is an actual (x, y) centerline + edge trace —
// the real course outline. It is for RENDERING ONLY ("not for timing"); the sim
// keeps using the radius-segment tracks.

export type XY = readonly [number, number];

export interface VisualTrack {
  name: string;
  closed: boolean;
  trackWidthM: number;
  centerline: XY[];
  leftEdge: XY[];
  rightEdge: XY[];
}

/** The serialized shape (snake_case) of a *-visual.json export. */
export interface RawVisualTrack {
  name: string;
  closed: boolean;
  track_width_assumed_m?: number;
  centerline: XY[];
  left_edge: XY[];
  right_edge: XY[];
}

export function parseVisualTrack(raw: RawVisualTrack): VisualTrack {
  return {
    name: raw.name,
    closed: raw.closed,
    trackWidthM: raw.track_width_assumed_m ?? 3.5,
    centerline: raw.centerline,
    leftEdge: raw.left_edge,
    rightEdge: raw.right_edge,
  };
}

/** Axis-aligned bounds of a point cloud (for equal-aspect fitting). */
export function boundsOf(points: XY[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
  return { minX, minY, maxX, maxY };
}

/** Per-point local turn radius (m) along a centerline, via the circumradius of
 *  each (i-1, i, i+1) triple (Menger curvature). Near-collinear triples →
 *  Infinity (straight). Endpoints copy their neighbor. Used to color the trace
 *  by corner tightness; approximate (trace noise), display only. */
export function visualCurvatureRadii(centerline: XY[]): number[] {
  const n = centerline.length;
  const out = new Array<number>(n).fill(Infinity);
  for (let i = 1; i < n - 1; i++) {
    const [ax, ay] = centerline[i - 1]!;
    const [bx, by] = centerline[i]!;
    const [cx, cy] = centerline[i + 1]!;
    const ab = Math.hypot(bx - ax, by - ay);
    const bc = Math.hypot(cx - bx, cy - by);
    const ca = Math.hypot(ax - cx, ay - cy);
    // Twice the signed triangle area.
    const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (area2 < 1e-9 || ab < 1e-9 || bc < 1e-9) {
      out[i] = Infinity; // collinear → straight
    } else {
      out[i] = (ab * bc * ca) / (2 * area2); // circumradius R = abc / (4·Area)
    }
  }
  if (n > 2) {
    out[0] = out[1]!;
    out[n - 1] = out[n - 2]!;
  }
  return out;
}

/** Build a SIM track (radius vs distance) from the traced visual centerline —
 *  the real course geometry, replacing the hand-synthesized constant-radius
 *  arcs that made the solver ride flat corner-speed ceilings (RPM "hangs").
 *
 *  Method: per-point Menger curvature κ along the centerline, then an
 *  arc-length-weighted moving average of κ over ±smoothM/2 (κ is the right
 *  thing to smooth — radii blow up to ∞ on straights). The window stands in
 *  for both tracing noise and the driver's line smoothing. Radii above
 *  `maxRadius` read as straights; below `minRadius` clamp to it (rules floor
 *  for hairpins — guards tracing pinches). One segment per centerline
 *  interval, so the radius profile varies continuously like the real course. */
export function trackFromVisual(
  visual: VisualTrack,
  opts: { smoothM?: number; maxRadius?: number; minRadius?: number; scaleToLength?: number } = {},
): Track {
  const { smoothM = 10, maxRadius = 250, minRadius = 4.5, scaleToLength } = opts;
  const pts = visual.centerline;
  const n = pts.length;
  const radii = visualCurvatureRadii(pts);
  // segment lengths (ds[i] = distance from point i to i+1)
  const ds = new Array<number>(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    ds[i] = Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  }
  // curvature per point, smoothed over an arc-length window
  const kappa = radii.map((r) => (Number.isFinite(r) && r > 0 ? 1 / r : 0));
  const half = smoothM / 2;
  const smooth = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = kappa[i]!;
    let w = 1;
    // walk outward in both directions until the half-window is exhausted
    for (const dir of [-1, 1] as const) {
      let dist = 0;
      let j = i;
      for (;;) {
        const next = j + dir;
        if (next < 0 || next >= n) break;
        dist += dir === 1 ? ds[j]! : ds[next]!;
        if (dist > half) break;
        acc += kappa[next]!;
        w += 1;
        j = next;
      }
    }
    smooth[i] = acc / w;
  }
  // Optional uniform rescale to a known true length (e.g. the rules-nominal
  // course length when the traced map's scale bar is suspect). Geometry
  // scales linearly: lengths AND radii both multiply by s.
  let s = 1;
  if (scaleToLength != null && scaleToLength > 0) {
    const raw = ds.reduce((a, b) => a + b, 0);
    if (raw > 0) s = scaleToLength / raw;
  }
  const segments: TrackSegment[] = [];
  for (let i = 0; i < n - 1; i++) {
    const kMid = (smooth[i]! + smooth[i + 1]!) / 2;
    const r = kMid > 1 / maxRadius ? Math.max(minRadius, 1 / kMid) : Infinity;
    if (ds[i]! > 1e-6) {
      segments.push({ length: ds[i]! * s, radius: Number.isFinite(r) ? r * s : r });
    }
  }
  return { name: `${visual.name} (traced)`, segments, closed: visual.closed };
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
