// Sensitivity tornado — a diverging horizontal bar chart, hand-rolled SVG (NOT
// uPlot), matching ScatterPlot/ParallelCoordsPlot idioms (useElementWidth,
// padding, axis lines/labels, role="img"). One bar per tunable; bar length is
// the absolute Spearman correlation against the active objective (domain fixed
// to ±1 so magnitudes compare across charts), mirrored about a center zero line
// so the sign reads visually. Color encodes FAVORABILITY (does moving this knob
// push the objective in the better direction), not raw sign — that's the
// actionable read. Bars are pre-sorted strongest-first by the caller. Clicking a
// bar bubbles its label.

import { useRef } from "react";

import { useElementWidth } from "./useElementWidth";

export interface TornadoBar {
  label: string;
  /** Signed correlation in [-1, 1]. */
  value: number;
  /** True when increasing this parameter moves the objective the better way. */
  favorable: boolean;
  /** Sample size the correlation was computed over (shown in the title attr). */
  n?: number;
}

interface Props {
  title: string;
  bars: TornadoBar[];
  /** Caption under the axis, e.g. "Spearman ρ vs total pts (higher better)". */
  axisLabel?: string;
  selectedLabel?: string | null;
  onBarClick?: (label: string) => void;
}

// Favorable = gold (helps the objective); unfavorable = muted red (hurts it).
const FILL_FAVORABLE = "#FFC627";
const FILL_UNFAVORABLE = "#F0826B";

export function TornadoChart({ title, bars, axisLabel, selectedLabel, onBarClick }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 600), 240);

  const gutter = 132; // left label gutter (param paths can be long)
  const padRight = 44; // room for the value label at a bar's outer end
  const padTop = 10;
  const padBottom = 26;
  const rowH = 22;
  const plotH = Math.max(rowH, bars.length * rowH);
  const height = padTop + plotH + padBottom;

  const plotLeft = gutter;
  const plotRight = width - padRight;
  const plotW = Math.max(1, plotRight - plotLeft);
  const center = plotLeft + plotW / 2;
  // Fixed ±1 domain — a half-width corresponds to |ρ| = 1.
  const xOf = (v: number) => center + (Math.max(-1, Math.min(1, v)) * plotW) / 2;

  const cursor = onBarClick ? "pointer" : "default";

  return (
    <div ref={hostRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
      </div>
      {bars.length === 0 ? (
        <div className="px-2 py-6 text-center text-[10px] text-[#5A5F66]">
          Not enough varied trials yet — sensitivity needs ≥3 trials where the knob moves.
        </div>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title} sensitivity tornado`}
          className="block overflow-visible"
        >
          {/* Center zero line + ±1 domain ticks. */}
          <line x1={center} y1={padTop} x2={center} y2={padTop + plotH} stroke="#3f3f46" />
          <line x1={plotLeft} y1={padTop + plotH} x2={plotRight} y2={padTop + plotH} stroke="#3f3f46" />
          <text x={plotLeft} y={padTop + plotH + 12} fontSize="9" fill="#71717a" textAnchor="start">
            −1
          </text>
          <text x={center} y={padTop + plotH + 12} fontSize="9" fill="#71717a" textAnchor="middle">
            0
          </text>
          <text x={plotRight} y={padTop + plotH + 12} fontSize="9" fill="#71717a" textAnchor="end">
            +1
          </text>
          {axisLabel && (
            <text
              x={center}
              y={padTop + plotH + 24}
              fontSize="10"
              fill="#D8DCE2"
              textAnchor="middle"
            >
              {axisLabel}
            </text>
          )}

          {bars.map((b, i) => {
            const yMid = padTop + i * rowH + rowH / 2;
            const x = xOf(b.value);
            const barLeft = Math.min(center, x);
            const barW = Math.abs(x - center);
            const fill = b.favorable ? FILL_FAVORABLE : FILL_UNFAVORABLE;
            const selected = selectedLabel === b.label;
            return (
              <g
                key={b.label}
                style={{ cursor }}
                onClick={() => onBarClick?.(b.label)}
              >
                {/* Full-row hit target so the label + empty space are clickable. */}
                <rect
                  x={0}
                  y={yMid - rowH / 2}
                  width={width}
                  height={rowH}
                  fill={selected ? "#16171B" : "transparent"}
                />
                {/* Param label in the left gutter, right-aligned to the plot edge. */}
                <text
                  x={plotLeft - 6}
                  y={yMid + 3}
                  fontSize="10"
                  fill={selected ? "#FFFFFF" : "#9097A0"}
                  textAnchor="end"
                >
                  {b.label}
                </text>
                <rect
                  x={barLeft}
                  y={yMid - 6}
                  width={Math.max(1, barW)}
                  height={12}
                  fill={fill}
                  opacity={selected ? 1 : 0.85}
                  rx={1}
                >
                  <title>
                    {b.label}: ρ = {b.value.toFixed(3)}
                    {b.n != null ? ` (n=${b.n})` : ""} — {b.favorable ? "favorable" : "unfavorable"}
                  </title>
                </rect>
                {/* Signed value at the bar's outer end. */}
                <text
                  x={b.value >= 0 ? x + 4 : x - 4}
                  y={yMid + 3}
                  fontSize="9"
                  fill="#D8DCE2"
                  textAnchor={b.value >= 0 ? "start" : "end"}
                >
                  {b.value >= 0 ? "+" : ""}
                  {b.value.toFixed(2)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
