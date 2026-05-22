// Parallel-coordinates plot, hand-rolled SVG. Each polyline is one trial;
// axes are scaled to the visible data range. Click-to-select bubbles up
// via `onTrialClick`. The best-trial polyline is amber; the selected
// polyline is white-on-top so it stays visible.

import { useMemo } from "react";

export interface ParallelCoordsTrial {
  trialIdx: number;
  /** length = axes.length - 1 (last axis is the objective) */
  values: number[];
  objective: number;
  bestTrial?: boolean;
}

interface Props {
  axes: { label: string; min: number; max: number }[];
  trials: ParallelCoordsTrial[];
  height?: number;
  onTrialClick?: (trialIdx: number) => void;
  selectedTrialIdx?: number | null;
}

export function ParallelCoordsPlot({
  axes,
  trials,
  height = 360,
  onTrialClick,
  selectedTrialIdx,
}: Props) {
  const width = Math.max(600, axes.length * 120);
  const padLeft = 40;
  const padRight = 40;
  const padTop = 28;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const axisX = (i: number) =>
    padLeft + (axes.length <= 1 ? plotW / 2 : (plotW * i) / (axes.length - 1));

  const yOf = (axisIdx: number, value: number) => {
    const ax = axes[axisIdx];
    if (!ax || ax.max === ax.min) return padTop + plotH / 2;
    const t = (value - ax.min) / (ax.max - ax.min);
    return padTop + plotH * (1 - t);
  };

  const objAxis = axes[axes.length - 1];
  const objMin = objAxis?.min ?? 0;
  const objMax = objAxis?.max ?? 1;
  const colorFor = (obj: number): string => {
    if (objMax === objMin) return "rgba(99,102,241,0.6)";
    const t = Math.max(0, Math.min(1, (obj - objMin) / (objMax - objMin)));
    // viridis-ish lerp: deep blue -> teal -> yellow.
    const r = Math.round(68 + (253 - 68) * t);
    const g = Math.round(1 + (231 - 1) * t);
    const b = Math.round(84 + (37 - 84) * t);
    return `rgba(${r},${g},${b},0.7)`;
  };

  const allValues = useMemo(
    () => trials.map((t) => [...t.values, t.objective]),
    [trials],
  );

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Parallel coordinates of trials"
      className="overflow-visible"
    >
      {/* Axes */}
      {axes.map((ax, i) => (
        <g key={i}>
          <line
            x1={axisX(i)}
            y1={padTop}
            x2={axisX(i)}
            y2={padTop + plotH}
            stroke="#3f3f46"
          />
          <text
            x={axisX(i)}
            y={padTop - 14}
            fontSize="10"
            fill="#D8DCE2"
            textAnchor="middle"
          >
            {ax.label}
          </text>
          <text
            x={axisX(i)}
            y={padTop - 2}
            fontSize="9"
            fill="#71717a"
            textAnchor="middle"
          >
            {Number.isFinite(ax.max) ? ax.max.toPrecision(3) : "—"}
          </text>
          <text
            x={axisX(i)}
            y={padTop + plotH + 12}
            fontSize="9"
            fill="#71717a"
            textAnchor="middle"
          >
            {Number.isFinite(ax.min) ? ax.min.toPrecision(3) : "—"}
          </text>
        </g>
      ))}

      {/* Non-selected, non-best trials first (drawn under). */}
      {trials.map((t, idx) => {
        if (selectedTrialIdx === t.trialIdx || t.bestTrial) return null;
        const points = (allValues[idx] ?? [])
          .map((v, i) => `${axisX(i)},${yOf(i, v)}`)
          .join(" ");
        return (
          <polyline
            key={t.trialIdx}
            points={points}
            fill="none"
            stroke={colorFor(t.objective)}
            strokeWidth={1}
            style={{ cursor: onTrialClick ? "pointer" : "default" }}
            onClick={() => onTrialClick?.(t.trialIdx)}
          />
        );
      })}

      {/* Best trial on top, but under selected. */}
      {trials.map((t, idx) => {
        if (!t.bestTrial || selectedTrialIdx === t.trialIdx) return null;
        const points = (allValues[idx] ?? [])
          .map((v, i) => `${axisX(i)},${yOf(i, v)}`)
          .join(" ");
        return (
          <polyline
            key={`best-${t.trialIdx}`}
            points={points}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={2}
            style={{ cursor: onTrialClick ? "pointer" : "default" }}
            onClick={() => onTrialClick?.(t.trialIdx)}
          />
        );
      })}

      {/* Selected on very top. */}
      {trials.map((t, idx) => {
        if (selectedTrialIdx !== t.trialIdx) return null;
        const points = (allValues[idx] ?? [])
          .map((v, i) => `${axisX(i)},${yOf(i, v)}`)
          .join(" ");
        return (
          <polyline
            key={`sel-${t.trialIdx}`}
            points={points}
            fill="none"
            stroke="#fafafa"
            strokeWidth={2.5}
            style={{ cursor: onTrialClick ? "pointer" : "default" }}
            onClick={() => onTrialClick?.(t.trialIdx)}
          />
        );
      })}
    </svg>
  );
}
