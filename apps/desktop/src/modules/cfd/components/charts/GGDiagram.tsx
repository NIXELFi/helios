// g-g diagram: every lap-sim sample plotted as (lateral g, longitudinal g),
// colored by its limit state. The point-mass sim has no corner direction, so
// lateral g is unsigned — this is the RIGHT half of the classic g-g plot.
// A dashed friction ellipse at STATIC load (μ·1g) is drawn for reference;
// points outside it show what aero downforce buys at speed.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";
import type { LimitState } from "../../lib/performance";

export const LIMIT_COLOR: Record<LimitState, string> = {
  power: "#FFC627", // engine-bound — the engine team's territory
  grip: "#F48FB1", // traction-limited corner exit
  corner: "#4FC3F7", // lateral ceiling
  brake: "#FF5252",
  coast: "#5A5F66",
};

interface Props {
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
  const maxLat = Math.max(muLat * 1.2, ...latG.filter(Number.isFinite)) * 1.06;
  const maxLong = Math.max(muLat * 1.2, ...longG.map(Math.abs).filter(Number.isFinite)) * 1.06;
  const sx = (width - 2 * pad) / Math.max(1e-6, maxLat);
  const sy = (height - 2 * pad) / Math.max(1e-6, 2 * maxLong);
  const px = (lat: number) => pad + lat * sx;
  const py = (lon: number) => height / 2 - lon * sy;

  // Static friction ellipse (no aero): brake half uses μ_lat (4-tire), accel
  // half μ_long (rear-axle launch limit) — matching the sim's braking model.
  const envelope = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 48; i++) {
      const th = (i / 48) * Math.PI; // +long → −long sweep, lat ≥ 0
      const lat = muLat * Math.sin(th);
      const lon = Math.cos(th) * (Math.cos(th) >= 0 ? muLong : muLat);
      pts.push(`${px(lat).toFixed(1)},${py(lon).toFixed(1)}`);
    }
    return pts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muLat, muLong, width, height]);

  const gridG = Math.ceil(Math.max(maxLat, maxLong));

  return (
    <div ref={hostRef} className="w-full" style={{ minHeight: height }}>
      <svg width={width} height={height} role="img" aria-label="g-g diagram" className="block">
        {/* Grid rings every 0.5 g (quarter circles in lat ≥ 0). */}
        {Array.from({ length: gridG * 2 }, (_, i) => (i + 1) * 0.5).map((g) => (
          <path
            key={g}
            d={`M ${px(0)} ${py(g)} A ${g * sx} ${g * sy} 0 0 1 ${px(g)} ${py(0)} A ${g * sx} ${g * sy} 0 0 1 ${px(0)} ${py(-g)}`}
            fill="none"
            stroke="#1B1D22"
            strokeWidth={1}
          />
        ))}
        <line x1={px(0)} y1={py(0)} x2={px(maxLat)} y2={py(0)} stroke="#2A2C32" strokeWidth={1} />
        <line x1={px(0)} y1={pad / 2} x2={px(0)} y2={height - pad / 2} stroke="#2A2C32" strokeWidth={1} />
        {/* Static friction-ellipse reference. */}
        <polyline points={envelope} fill="none" stroke="#9097A0" strokeWidth={1} strokeDasharray="4 3" />
        {latG.map((la, i) => {
          const lo = longG[i]!;
          if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
          return <circle key={i} cx={px(la)} cy={py(lo)} r={1.8} fill={LIMIT_COLOR[limit[i] ?? "coast"]} fillOpacity={0.8} />;
        })}
        {/* Axis labels. */}
        <text x={width - pad} y={py(0) - 5} textAnchor="end" fill="#5A5F66" fontSize={9}>
          lateral g →
        </text>
        <text x={px(0) + 5} y={pad} fill="#5A5F66" fontSize={9}>
          accel g
        </text>
        <text x={px(0) + 5} y={height - pad / 2} fill="#5A5F66" fontSize={9}>
          brake g
        </text>
      </svg>
    </div>
  );
}
