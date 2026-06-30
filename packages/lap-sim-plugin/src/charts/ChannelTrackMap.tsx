// Channel-colored track map: the traced course ribbon (VisualTrack) with the
// centerline painted by a lap-sim channel (speed, rpm, gear, g's, limit state…).
// The sim runs on the radius-segment Track, not this trace, so channel samples
// are mapped onto the visual centerline by FRACTIONAL ARC LENGTH — an honest
// display approximation (the two represent the same course at slightly
// different lengths). Equal-aspect fit, same chrome as TrackLayout.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";
import { boundsOf, type VisualTrack, type XY } from "@helios/lapsim-core";

interface Props {
  track: VisualTrack;
  /** Distance fraction (0..1 of lap length) per channel sample, ascending. */
  fracs: number[];
  /** Pre-computed color per channel sample (parent owns the scale/legend). */
  colors: string[];
  height?: number;
  /** Live car markers (lap player): position by lap-distance fraction. */
  markers?: { frac: number; color: string; label?: string }[];
}

/** Cumulative arc-length fraction at each centerline point. */
function cumFracs(points: XY[]): number[] {
  const cum = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    cum[i] =
      cum[i - 1]! +
      Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  const total = cum[cum.length - 1] || 1;
  return cum.map((c) => c / total);
}

/** Interpolated centerline position at arc-length fraction `f` (0..1). */
function pointAtFrac(points: XY[], vf: number[], f: number): XY {
  const n = points.length;
  if (n === 0) return [0, 0];
  const ff = Math.min(1, Math.max(0, f));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vf[mid]! <= ff) lo = mid;
    else hi = mid;
  }
  const span = Math.max(1e-12, vf[hi]! - vf[lo]!);
  const u = (ff - vf[lo]!) / span;
  const a = points[lo]!;
  const b = points[hi]!;
  return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
}

export function ChannelTrackMap({ track, fracs, colors, height = 300, markers }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 380), 200);

  const pad = 14;
  const { minX, minY, maxX, maxY } = useMemo(
    () => boundsOf([...track.leftEdge, ...track.rightEdge]),
    [track],
  );
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const px = (p: XY) => offX + (p[0] - minX) * scale;
  const py = (p: XY) => offY + (maxY - p[1]) * scale;

  const ribbon = useMemo(() => {
    const fwd = track.leftEdge.map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`);
    const back = [...track.rightEdge].reverse().map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`);
    return [...fwd, ...back].join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, width, height]);

  // Each centerline segment gets the color of the nearest channel sample (by
  // lap fraction). Two-pointer walk — both sequences are ascending.
  const segs = useMemo(() => {
    const vf = cumFracs(track.centerline);
    const out: { x1: number; y1: number; x2: number; y2: number; c: string }[] = [];
    if (fracs.length === 0 || colors.length === 0) return out;
    let j = 0;
    for (let i = 1; i < track.centerline.length; i++) {
      const f = (vf[i - 1]! + vf[i]!) / 2;
      while (j < fracs.length - 1 && fracs[j + 1]! <= f) j++;
      const a = track.centerline[i - 1]!;
      const b = track.centerline[i]!;
      out.push({ x1: px(a), y1: py(a), x2: px(b), y2: py(b), c: colors[j] ?? "#5A5F66" });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, fracs, colors, width, height]);

  const start = track.centerline[0];
  const finish = track.centerline[track.centerline.length - 1];

  // Centerline arc-length table — once per track, NOT per marker per frame.
  const centerFracs = useMemo(() => cumFracs(track.centerline), [track]);

  // The ribbon + ~10³ colored segments never change while the lap player
  // animates (only `markers` does, 60×/s). Freeze them as a memoized element
  // so React skips reconciling the whole static layer on every frame — this
  // is what made playback laggy.
  const staticLayer = useMemo(
    () => (
      <g>
        <polygon points={ribbon} fill="#1B1D22" stroke="#2A2C32" strokeWidth={1} />
        {segs.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.c} strokeWidth={3} strokeLinecap="round" />
        ))}
        {start && <circle cx={px(start)} cy={py(start)} r={4} fill="#FAFAFA" stroke="#0E0E10" strokeWidth={1} />}
        {finish && !track.closed && (
          <circle cx={px(finish)} cy={py(finish)} r={4} fill="#FF5252" stroke="#0E0E10" strokeWidth={1} />
        )}
      </g>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ribbon, segs, track, width, height],
  );

  return (
    <div ref={hostRef} className="w-full" style={{ minHeight: height }}>
      <svg width={width} height={height} role="img" aria-label={`${track.name} channel map`} className="block">
        {staticLayer}
        {markers?.map((mk, i) => {
          const p = pointAtFrac(track.centerline, centerFracs, mk.frac);
          return (
            <g key={i}>
              <circle cx={px(p)} cy={py(p)} r={6} fill={mk.color} stroke="#0E0E10" strokeWidth={1.5} />
              {mk.label && (
                <text x={px(p) + 9} y={py(p) + 3.5} fontSize={10} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fill={mk.color}>
                  {mk.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
