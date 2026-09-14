"use client";

import { useState } from "react";
import { ChartFrame, type FrameMilestone } from "./ChartFrame";
import { HoverTip, type HoverTipRow } from "./HoverTip";
import { shortDay } from "./scale";

// ---------------------------------------------------------------------------
// StackedWeeks: one column per ISO week, stacked by series (subteam or person),
// with a full-height hit target per column that shows every series in the
// HoverTip. Columns outside the selected window are drawn faded so a short
// preset ("This week") still has trailing context without pretending those
// weeks are part of the numbers. Hit targets are focusable, so keyboard users
// get the same tip.
// ---------------------------------------------------------------------------

export interface WeekSeries {
  id: string;
  label: string;
  color: string;
}

export interface WeekColumn {
  key: string;
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  /** Per-series counts keyed by series id. */
  values: Readonly<Record<string, number>>;
  total: number;
  /** False for trailing context weeks before the selected window. */
  inWindow: boolean;
  isCurrent: boolean;
}

export interface StackedWeeksProps {
  columns: ReadonlyArray<WeekColumn>;
  series: ReadonlyArray<WeekSeries>;
  height?: number;
  milestones?: ReadonlyArray<FrameMilestone>;
  ariaLabel: string;
  /** Noun for the tip footer and aria labels, e.g. "completed". */
  unit?: string;
}

export function StackedWeeks({
  columns,
  series,
  height = 200,
  milestones,
  ariaLabel,
  unit = "completed",
}: StackedWeeksProps) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const yMax = Math.max(1, ...columns.map((c) => c.total));
  const hovered = hover ? columns[hover.index] ?? null : null;

  const anchor = (el: Element, index: number) => {
    const b = el.getBoundingClientRect();
    setHover({ index, x: b.left + b.width / 2, y: b.top });
  };

  return (
    <div className="flex flex-col gap-2">
      <ChartFrame height={height} yMax={yMax} columns={columns} milestones={milestones} ariaLabel={ariaLabel}>
        {(s) => {
          const barW = Math.max(3, s.slot * 0.62);
          return (
            <>
              {columns.map((c, i) => {
                let cursor = s.y(0);
                const x = s.colX(i) + (s.slot - barW) / 2;
                const isHover = hover?.index === i;
                return (
                  <g key={c.key} className={c.inWindow ? "" : "opacity-40"}>
                    {series.map((ser) => {
                      const n = c.values[ser.id] ?? 0;
                      if (n <= 0) return null;
                      const top = s.y(n) - s.y(0);
                      cursor += top;
                      return (
                        <rect
                          key={ser.id}
                          x={x}
                          y={cursor}
                          width={barW}
                          height={-top}
                          fill={ser.color}
                          className={`motion-safe:transition-opacity ${hover && !isHover ? "opacity-70" : ""}`}
                        />
                      );
                    })}
                  </g>
                );
              })}
              {/* Hit targets on top so the tip works over empty columns too. */}
              {columns.map((c, i) => (
                <rect
                  key={`hit-${c.key}`}
                  x={s.colX(i)}
                  y={s.plotTop}
                  width={s.slot}
                  height={s.plotBottom - s.plotTop}
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={`Week of ${shortDay(c.weekStart)}: ${c.total} ${unit}`}
                  className="cursor-default outline-none focus-visible:stroke-asu-gold"
                  onMouseEnter={(e) => anchor(e.currentTarget, i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={(e) => anchor(e.currentTarget, i)}
                  onBlur={() => setHover(null)}
                />
              ))}
            </>
          );
        }}
      </ChartFrame>

      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {series.map((ser) => (
            <li key={ser.id} className="flex items-center gap-1.5 text-xs text-helios-dim">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: ser.color }} />
              {ser.label}
            </li>
          ))}
        </ul>
      ) : null}

      {hover && hovered ? (
        <HoverTip
          x={hover.x}
          y={hover.y}
          title={`Week of ${shortDay(hovered.weekStart)}${hovered.inWindow ? "" : " (before window)"}`}
          rows={tipRows(hovered, series)}
          footer={`${hovered.total} ${unit}`}
        />
      ) : null}
    </div>
  );
}

function tipRows(col: WeekColumn, series: ReadonlyArray<WeekSeries>): HoverTipRow[] {
  const rows = series.map((ser) => ({
    label: ser.label,
    value: col.values[ser.id] ?? 0,
    swatch: ser.color,
    muted: (col.values[ser.id] ?? 0) === 0,
  }));
  // Non-zero rows first, largest on top, zeros trailing so the eye lands on
  // what actually happened that week.
  rows.sort((a, b) => Number(b.value) - Number(a.value));
  return rows;
}
