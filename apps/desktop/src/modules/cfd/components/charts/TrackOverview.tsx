// Track overview — a plan-view schematic of the loaded course plus a faithful
// curvature-vs-distance strip. Hand-rolled SVG (matches the module's chart
// idioms: useElementWidth, role="img", #FFC627 accent palette).
//
// HONESTY NOTE: the Track carries corner RADIUS vs distance but no turn
// direction, so the plan view's left/right and overall outline are APPROXIMATED
// (trackGeometry.ts steers toward a compact serpentine). Corner tightness,
// straight/corner sequence, and lengths ARE real. The strip below is fully
// faithful — it's exactly the radius profile the lap sim integrates. Both are
// labeled accordingly so nobody mistakes the squiggle for the true layout.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";
import {
  trackPlan,
  tightnessOf,
  TIGHTNESS_COLOR,
  trackLength,
  discretizeTrack,
  type Track,
} from "../../lib/performance";

interface Props {
  track: Track;
  height?: number;
}

export function TrackOverview({ track, height = 260 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 600), 240);

  const plan = useMemo(() => trackPlan(track), [track]);
  const profile = useMemo(() => discretizeTrack(track, 3), [track]);
  const len = trackLength(track);

  // --- Plan-view geometry: fit the polyline bbox into the top panel ---------
  const planH = Math.round(height * 0.62);
  const stripH = height - planH;
  const pad = 18;
  const { minX, minY, maxX, maxY } = plan.bbox;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * pad) / spanX, (planH - 2 * pad) / spanY);
  // Center the fitted shape; flip Y so +y points up (SVG y grows down).
  const offX = (width - spanX * scale) / 2;
  const offY = (planH - spanY * scale) / 2;
  const px = (x: number) => offX + (x - minX) * scale;
  const py = (y: number) => planH - (offY + (y - minY) * scale);

  // Build colored sub-paths: break the polyline where the tightness bucket
  // changes so each run draws in its own color (one <polyline> per run).
  const runs = useMemo(() => {
    const out: { color: string; pts: string }[] = [];
    let curColor = "";
    let buf: string[] = [];
    let prev: string | null = null;
    for (const p of plan.points) {
      const color = TIGHTNESS_COLOR[tightnessOf(p.radius)];
      const xy = `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`;
      if (color !== curColor) {
        if (buf.length > 1) out.push({ color: curColor, pts: buf.join(" ") });
        // Start the new run at the boundary point so runs connect seamlessly.
        buf = prev ? [prev, xy] : [xy];
        curColor = color;
      } else {
        buf.push(xy);
      }
      prev = xy;
    }
    if (buf.length > 1) out.push({ color: curColor, pts: buf.join(" ") });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, width, planH]);

  const start = plan.points[0];
  const finish = plan.points[plan.points.length - 1];

  // --- Curvature strip: 1/R vs distance (faithful to what the sim sees) -----
  const maxCurv = useMemo(() => {
    let m = 0;
    for (const r of profile.radius) {
      const c = Number.isFinite(r) && r > 0 ? 1 / r : 0;
      if (c > m) m = c;
    }
    return m || 1;
  }, [profile]);

  const stripTop = planH + 6;
  const stripBottom = height - 14;
  const stripPlotH = Math.max(8, stripBottom - stripTop);
  const stripBars = useMemo(() => {
    const n = profile.radius.length;
    const bw = (width - 2 * pad) / n;
    return profile.radius.map((r, i) => {
      const c = Number.isFinite(r) && r > 0 ? 1 / r : 0;
      const h = (c / maxCurv) * stripPlotH;
      return {
        x: pad + i * bw,
        w: Math.max(0.6, bw),
        y: stripBottom - h,
        h,
        color: TIGHTNESS_COLOR[tightnessOf(r)],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, maxCurv, width, stripPlotH]);

  return (
    <div ref={hostRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">
          {track.name} · {len.toFixed(0)} m · {track.closed ? "closed loop" : "point-to-point"}
        </div>
        <div className="flex items-center gap-2 text-[8px] uppercase tracking-wider text-[#5A5F66]">
          {(["straight", "open", "medium", "tight", "hairpin"] as const).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-2.5 rounded-sm" style={{ background: TIGHTNESS_COLOR[t] }} />
              {t}
            </span>
          ))}
        </div>
      </div>

      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${track.name} track overview`}
        className="block"
      >
        {/* Plan-view polyline, colored by corner tightness. */}
        {runs.map((r, i) => (
          <polyline
            key={i}
            points={r.pts}
            fill="none"
            stroke={r.color}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {start && (
          <>
            <circle cx={px(start.x)} cy={py(start.y)} r={4} fill="#A5D6A7" stroke="#0E0E10" strokeWidth={1} />
            <text x={px(start.x) + 6} y={py(start.y) - 4} fontSize="9" fill="#A5D6A7">start</text>
          </>
        )}
        {finish && (
          <>
            <circle cx={px(finish.x)} cy={py(finish.y)} r={4} fill="#FF5252" stroke="#0E0E10" strokeWidth={1} />
            {!track.closed && (
              <text x={px(finish.x) + 6} y={py(finish.y) + 10} fontSize="9" fill="#FF5252">finish</text>
            )}
          </>
        )}

        {/* Divider between the schematic and the faithful strip. */}
        <line x1={0} y1={planH} x2={width} y2={planH} stroke="#2A2C32" />

        {/* Curvature strip: 1/R vs distance. */}
        <line x1={pad} y1={stripBottom} x2={width - pad} y2={stripBottom} stroke="#3f3f46" />
        {stripBars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.color} opacity={0.9} />
        ))}
        <text x={pad} y={height - 3} fontSize="8" fill="#71717a" textAnchor="start">0 m</text>
        <text x={width - pad} y={height - 3} fontSize="8" fill="#71717a" textAnchor="end">{len.toFixed(0)} m</text>
        <text x={width / 2} y={stripTop + 8} fontSize="8" fill="#5A5F66" textAnchor="middle">
          curvature (1/R) vs distance — faithful
        </text>
      </svg>

      <p className="px-2 pb-1 pt-0.5 text-[9px] leading-tight text-[#5A5F66]">
        Plan view is a <span className="text-[#9097A0]">schematic</span> — corner tightness, lengths and the
        straight/corner sequence are real, but turn directions (and so the overall outline) are approximated
        (the model is direction-agnostic). The strip below is the exact radius profile the lap sim integrates.
      </p>
    </div>
  );
}
