// g-g diagram: every lap-sim sample plotted as (lateral g, longitudinal g),
// colored by its limit state. The point-mass sim has no corner direction, so
// the PARENT supplies signed lateral g (sign derived from the traced layout's
// curvature — cornerSignsAtFracs) and the plot draws the full classic circle:
// left turns one side, right turns the other. A dashed friction ellipse at
// STATIC load (μ·1g) is drawn for reference; points outside it show what aero
// downforce buys at speed.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";
import type { LimitState } from "@helios/lapsim-core";

export const LIMIT_COLOR: Record<LimitState, string> = {
  power: "#FFC627", // engine-bound — the engine team's territory
  grip: "#F48FB1", // traction-limited corner exit
  corner: "#4FC3F7", // lateral ceiling
  brake: "#FF5252",
  coast: "#5A5F66",
};

/** Display labels: "grip" reads ambiguously next to "corner" (both are
 *  tire-limited), so it displays as TRACTION — the driven tires can't put
 *  the engine's torque down (corner exit / launch) — vs CORNER = riding the
 *  lateral-speed ceiling mid-corner, where more power wouldn't help. */
export const LIMIT_LABEL: Record<LimitState, string> = {
  power: "power",
  grip: "traction",
  corner: "corner",
  brake: "brake",
  coast: "coast",
};

interface Props {
  /** Signed lateral g (negative = one turn direction, positive = the other). */
  latG: number[];
  longG: number[];
  limit: LimitState[];
  /** Static friction-ellipse radii (g): lateral and accel/brake reference. */
  muLat: number;
  muLong: number;
  height?: number;
}

export function GGDiagram({ latG, longG, limit, muLat, muLong, height = 280 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 320), 200);

  const pad = 28;
  const maxLat = Math.max(muLat * 1.2, ...latG.map(Math.abs).filter(Number.isFinite)) * 1.06;
  const maxLong = Math.max(muLong * 1.2, ...longG.map(Math.abs).filter(Number.isFinite)) * 1.06;
  const cx = width / 2;
  const sx = (width / 2 - pad) / Math.max(1e-6, maxLat);
  const sy = (height - 2 * pad) / Math.max(1e-6, 2 * maxLong);
  const px = (lat: number) => cx + lat * sx;
  const py = (lon: number) => height / 2 - lon * sy;

  // Static friction ellipse (no aero), full loop: brake half uses μ_lat
  // (4-tire), accel half μ_long (rear-axle launch limit) — matching the sim.
  const envelope = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 96; i++) {
      const th = (i / 96) * 2 * Math.PI;
      const lat = muLat * Math.sin(th);
      const lon = Math.cos(th) * (Math.cos(th) >= 0 ? muLong : muLat);
      pts.push(`${px(lat).toFixed(1)},${py(lon).toFixed(1)}`);
    }
    return pts.join(" ");
    // maxLat/maxLong feed px()/py() via sx/sy — without them the ellipse keeps
    // a stale pixel mapping when only the data (latG/longG extent) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muLat, muLong, maxLat, maxLong, width, height]);

  const gridG = Math.ceil(Math.max(maxLat, maxLong));

  return (
    <div ref={hostRef} className="w-full" style={{ minHeight: height }}>
      <svg width={width} height={height} role="img" aria-label="g-g diagram" className="block">
        {/* Grid rings every 0.5 g — full ellipses. */}
        {Array.from({ length: gridG * 2 }, (_, i) => (i + 1) * 0.5).map((g) => (
          <ellipse
            key={g}
            cx={cx}
            cy={height / 2}
            rx={g * sx}
            ry={g * sy}
            fill="none"
            stroke="#1B1D22"
            strokeWidth={1}
          />
        ))}
        <line x1={pad / 2} y1={py(0)} x2={width - pad / 2} y2={py(0)} stroke="#2A2C32" strokeWidth={1} />
        <line x1={cx} y1={pad / 2} x2={cx} y2={height - pad / 2} stroke="#2A2C32" strokeWidth={1} />
        {/* Static friction-ellipse reference. */}
        <polyline points={envelope} fill="none" stroke="#9097A0" strokeWidth={1} strokeDasharray="4 3" />
        {latG.map((la, i) => {
          const lo = longG[i]!;
          if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
          return <circle key={i} cx={px(la)} cy={py(lo)} r={1.8} fill={LIMIT_COLOR[limit[i] ?? "coast"]} fillOpacity={0.8} />;
        })}
        {/* Axis labels. */}
        <text x={pad / 2} y={py(0) - 5} fill="#5A5F66" fontSize={9}>
          ← left
        </text>
        <text x={width - pad / 2} y={py(0) - 5} textAnchor="end" fill="#5A5F66" fontSize={9}>
          right →
        </text>
        <text x={cx + 5} y={pad} fill="#5A5F66" fontSize={9}>
          accel g
        </text>
        <text x={cx + 5} y={height - pad / 2} fill="#5A5F66" fontSize={9}>
          brake g
        </text>
      </svg>
    </div>
  );
}
