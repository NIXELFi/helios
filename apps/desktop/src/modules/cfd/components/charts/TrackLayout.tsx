// True-layout track view — draws a VisualTrack's traced ribbon (left/right edge
// polygon) with the centerline colored by local corner tightness. This is the
// REAL course outline (display-only trace, "not for timing") — the lap sim still
// integrates the radius-segment Track. Equal-aspect fit so it's never distorted.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";
import {
  boundsOf,
  visualCurvatureRadii,
  tightnessOf,
  TIGHTNESS_COLOR,
  type VisualTrack,
  type XY,
} from "../../lib/performance";

interface Props {
  track: VisualTrack;
  height?: number;
}

function pathLength(points: XY[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return d;
}

export function TrackLayout({ track, height = 280 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 380), 200);

  const len = useMemo(() => pathLength(track.centerline), [track]);
  const radii = useMemo(() => visualCurvatureRadii(track.centerline), [track]);

  const pad = 16;
  // Equal-aspect fit over the full ribbon (edges include the widest extent).
  const { minX, minY, maxX, maxY } = useMemo(
    () => boundsOf([...track.leftEdge, ...track.rightEdge]),
    [track],
  );
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offX = (width - drawnW) / 2;
  const offY = (height - drawnH) / 2;
  // y-north (up) → SVG y grows down, so flip.
  const px = (p: XY) => offX + (p[0] - minX) * scale;
  const py = (p: XY) => offY + (maxY - p[1]) * scale;

  // Ribbon polygon: left edge forward, right edge back → closed surface.
  const ribbon = useMemo(() => {
    const fwd = track.leftEdge.map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`);
    const back = [...track.rightEdge].reverse().map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`);
    return [...fwd, ...back].join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, width, height]);

  // Centerline split into tightness-colored runs.
  const runs = useMemo(() => {
    const out: { color: string; pts: string }[] = [];
    let cur = "", buf: string[] = [], prev: string | null = null;
    track.centerline.forEach((p, i) => {
      const color = TIGHTNESS_COLOR[tightnessOf(radii[i] ?? Infinity)];
      const xy = `${px(p).toFixed(1)},${py(p).toFixed(1)}`;
      if (color !== cur) {
        if (buf.length > 1) out.push({ color: cur, pts: buf.join(" ") });
        buf = prev ? [prev, xy] : [xy];
        cur = color;
      } else buf.push(xy);
      prev = xy;
    });
    if (buf.length > 1) out.push({ color: cur, pts: buf.join(" ") });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, radii, width, height]);

  const start = track.centerline[0];
  const finish = track.centerline[track.centerline.length - 1];

  return (
    <div ref={hostRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">
          {track.name} · {(len / (track.closed ? 1000 : 1)).toFixed(track.closed ? 2 : 0)}{" "}
          {track.closed ? "km/lap" : "m"}
        </div>
        <span className="text-[9px] uppercase tracking-wider text-[#5A5F66]">
          {track.closed ? "closed loop" : "point-to-point"}
        </span>
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${track.name} track layout`}
        className="block"
      >
        {/* Traced track surface. */}
        <polygon points={ribbon} fill="#1B1D22" stroke="#2A2C32" strokeWidth={1} />
        {/* Centerline, colored by local corner tightness. */}
        {runs.map((r, i) => (
          <polyline key={i} points={r.pts} fill="none" stroke={r.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {start && <circle cx={px(start)} cy={py(start)} r={4} fill="#A5D6A7" stroke="#0E0E10" strokeWidth={1} />}
        {finish && !track.closed && <circle cx={px(finish)} cy={py(finish)} r={4} fill="#FF5252" stroke="#0E0E10" strokeWidth={1} />}
      </svg>
    </div>
  );
}
