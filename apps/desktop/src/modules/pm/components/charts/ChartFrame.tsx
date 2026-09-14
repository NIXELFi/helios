"use client";

import { useState, type ReactNode } from "react";
import { HoverTip } from "./HoverTip";
import { dayToColumn, labelIndices, niceTicks, shortDay } from "./scale";
import { useMeasuredWidth } from "./useMeasuredWidth";

// ---------------------------------------------------------------------------
// ChartFrame: the axes, gridlines, x labels, this-week band and milestone
// markers every week-column chart shares. Children get the pixel scales and
// draw their marks inside the plot area; the frame owns nothing about the data
// except its ceiling. Measured width (never a scaled viewBox), 10 px labels,
// tokens for every colour so a light theme is a token swap.
// ---------------------------------------------------------------------------

export interface FrameColumn {
  key: string;
  /** Monday of the column's week, YYYY-MM-DD. */
  weekStart: string;
  /** The column that contains today: drawn with a gold band behind it. */
  isCurrent?: boolean;
}

export interface FrameMilestone {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  day: string;
  /** Human label for the type ("design review"). */
  kind?: string;
}

export interface FrameScale {
  /** Left edge of column i, in px. */
  colX: (i: number) => number;
  /** Width of one column slot, in px. */
  slot: number;
  /** Pixel y for a value; y(0) is the baseline. */
  y: (v: number) => number;
  plotTop: number;
  plotBottom: number;
  width: number;
  height: number;
}

export interface ChartFrameProps {
  height: number;
  /** Raw data ceiling; the frame picks nice ticks above it. */
  yMax: number;
  columns: ReadonlyArray<FrameColumn>;
  milestones?: ReadonlyArray<FrameMilestone>;
  ariaLabel: string;
  children: (s: FrameScale) => ReactNode;
}

export const FRAME_PAD = { left: 30, right: 8, top: 10, bottom: 22 } as const;
const LABEL_W = 44;

export function ChartFrame({ height, yMax, columns, milestones = [], ariaLabel, children }: ChartFrameProps) {
  const [hostRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [msHover, setMsHover] = useState<{ id: string; x: number; y: number } | null>(null);

  const plotLeft = FRAME_PAD.left;
  const plotRight = Math.max(plotLeft + 1, width - FRAME_PAD.right);
  const plotTop = FRAME_PAD.top;
  const plotBottom = Math.max(plotTop + 1, height - FRAME_PAD.bottom);
  const { max, ticks } = niceTicks(yMax);
  const slot = columns.length > 0 ? (plotRight - plotLeft) / columns.length : 0;
  const colX = (i: number) => plotLeft + i * slot;
  const y = (v: number) => plotBottom - (v / max) * (plotBottom - plotTop);
  const labelled = labelIndices(columns.length, slot, LABEL_W);
  const weekStarts = columns.map((c) => c.weekStart);
  const currentIndex = columns.findIndex((c) => c.isCurrent);

  const placedMilestones = milestones
    .map((m) => ({ m, col: dayToColumn(m.day, weekStarts) }))
    .filter((p): p is { m: FrameMilestone; col: number } => p.col !== null);
  const hoveredMilestone = msHover ? placedMilestones.find((p) => p.m.id === msHover.id)?.m ?? null : null;

  return (
    <div ref={hostRef} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
        {/* This-week band, behind everything. */}
        {currentIndex >= 0 ? (
          <rect
            x={colX(currentIndex)}
            y={plotTop}
            width={slot}
            height={plotBottom - plotTop}
            className="fill-asu-gold/[0.07]"
          />
        ) : null}

        {/* Gridlines + y ticks. The baseline is solid; the rest sit at 60 %. */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? "stroke-helios-line" : "stroke-helios-line/60"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={plotLeft - 6}
              y={y(t) + 3.5}
              textAnchor="end"
              className="fill-helios-dim font-mono text-[10px] tabular-nums"
            >
              {t}
            </text>
          </g>
        ))}

        {children({ colX, slot, y, plotTop, plotBottom, width, height })}

        {/* X labels: the Monday of every week that fits, newest kept first. */}
        {columns.map((c, i) =>
          labelled.has(i) ? (
            <text
              key={c.key}
              x={colX(i) + slot / 2}
              y={height - 6}
              textAnchor="middle"
              className={`text-[10px] ${c.isCurrent ? "fill-helios-text" : "fill-helios-dim"}`}
            >
              {shortDay(c.weekStart)}
            </text>
          ) : null,
        )}

        {/* Milestone diamonds on the baseline; name on hover / focus. */}
        {placedMilestones.map(({ m, col }) => {
          const cx = plotLeft + col * slot;
          const cy = plotBottom;
          const r = 5;
          return (
            <g
              key={m.id}
              tabIndex={0}
              role="img"
              aria-label={`Milestone ${m.name}, ${shortDay(m.day)}`}
              className="cursor-default outline-none"
              onMouseEnter={(e) => {
                const b = (e.currentTarget as SVGGElement).getBoundingClientRect();
                setMsHover({ id: m.id, x: b.left + b.width / 2, y: b.top });
              }}
              onMouseLeave={() => setMsHover(null)}
              onFocus={(e) => {
                const b = (e.currentTarget as SVGGElement).getBoundingClientRect();
                setMsHover({ id: m.id, x: b.left + b.width / 2, y: b.top });
              }}
              onBlur={() => setMsHover(null)}
            >
              <polygon
                points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                className="fill-asu-gold stroke-helios-panel"
                strokeWidth={1.5}
              />
            </g>
          );
        })}
      </svg>

      {msHover && hoveredMilestone ? (
        <HoverTip
          x={msHover.x}
          y={msHover.y}
          title="Milestone"
          rows={[{ label: hoveredMilestone.name, value: shortDay(hoveredMilestone.day) }]}
          footer={hoveredMilestone.kind}
        />
      ) : null}
    </div>
  );
}
