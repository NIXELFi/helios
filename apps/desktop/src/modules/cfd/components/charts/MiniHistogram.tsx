// Time-weighted mini histogram for lap-sim channels (rpm residency, speed,
// g's). Bars = fraction of LAP TIME in each bin — "where does the car/engine
// actually live" — with an optional overlay series (B) drawn as an outline
// for A/B comparisons.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";

export interface HistSeries {
  /** Channel samples. */
  values: number[];
  /** Per-sample time weights (dt). Same length as values. */
  weights: number[];
  color: string;
  label: string;
}

interface Props {
  title: string;
  unit: string;
  series: HistSeries;
  /** Optional comparison series, drawn as an outline over the bars. */
  overlay?: HistSeries;
  bins?: number;
  height?: number;
}

function binup(s: HistSeries, lo: number, hi: number, bins: number): number[] {
  const fr = new Array<number>(bins).fill(0);
  const span = Math.max(1e-12, hi - lo);
  let total = 0;
  for (let i = 0; i < s.values.length; i++) {
    const w = s.weights[i] ?? 0;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((s.values[i]! - lo) / span) * bins)));
    fr[b]! += w;
    total += w;
  }
  return total > 0 ? fr.map((f) => f / total) : fr;
}

export function MiniHistogram({ title, unit, series, overlay, bins = 24, height = 150 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 300), 160);

  const model = useMemo(() => {
    const all = overlay ? [...series.values, ...overlay.values] : series.values;
    if (all.length === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of all) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) hi = lo + 1;
    const a = binup(series, lo, hi, bins);
    const b = overlay ? binup(overlay, lo, hi, bins) : null;
    const peak = Math.max(...a, ...(b ?? [0]), 1e-9);
    return { lo, hi, a, b, peak };
  }, [series, overlay, bins]);

  if (!model) return null;
  const padB = 16;
  const plotH = height - padB - 18;
  const bw = width / bins;
  const yOf = (f: number) => 18 + plotH * (1 - f / model.peak);

  return (
    <div ref={hostRef} className="w-full">
      <svg width={width} height={height} role="img" aria-label={`${title} histogram`} className="block">
        <text x={4} y={12} fontSize={9} fill="#9097A0" style={{ textTransform: "uppercase", letterSpacing: 1 }}>
          {title}
        </text>
        {model.a.map((f, i) =>
          f > 0 ? (
            <rect
              key={i}
              x={i * bw + 1}
              y={yOf(f)}
              width={Math.max(1, bw - 2)}
              height={18 + plotH - yOf(f)}
              fill={series.color}
              opacity={0.75}
            >
              <title>{`${(model.lo + ((i + 0.5) / bins) * (model.hi - model.lo)).toFixed(0)} ${unit}: ${(f * 100).toFixed(1)}% of lap time (${series.label})`}</title>
            </rect>
          ) : null,
        )}
        {model.b && (
          <polyline
            points={model.b
              .map((f, i) => `${i * bw + bw / 2},${yOf(f).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke={overlay!.color}
            strokeWidth={1.5}
          />
        )}
        <text x={2} y={height - 4} fontSize={8} fill="#5A5F66" fontFamily="'JetBrains Mono Variable', ui-monospace, monospace">
          {model.lo.toFixed(0)}
        </text>
        <text x={width - 2} y={height - 4} fontSize={8} fill="#5A5F66" fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" textAnchor="end">
          {model.hi.toFixed(0)} {unit}
        </text>
      </svg>
    </div>
  );
}
