"use client";

import { useState, type ReactNode } from "react";
import { HoverTip } from "./HoverTip";

// ---------------------------------------------------------------------------
// BarStrip: one horizontal segmented bar — done / in progress / review /
// blocked / not started — with a label on the left and right-aligned numbers.
// Every row in a panel shares the same `max` so bar lengths compare across
// rows, not just within one. Hovering the bar lists the segments in the shared
// HoverTip. Powers the Subteams and Workload panels.
// ---------------------------------------------------------------------------

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface BarStripProps {
  /** Left column: a name, usually with a swatch, usually a link. */
  label: ReactNode;
  segments: ReadonlyArray<BarSegment>;
  /** Scale for the bar: the largest row total in the panel. */
  max: number;
  /** Right column: the numbers. */
  trailing?: ReactNode;
  /** Tip heading. */
  title?: string;
  /** Width class for the label column so rows align. */
  labelClass?: string;
  emphasis?: boolean;
}

export function BarStrip({
  label,
  segments,
  max,
  trailing,
  title,
  labelClass = "w-32",
  emphasis = false,
}: BarStripProps) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const total = segments.reduce((n, s) => n + s.value, 0);
  const scale = Math.max(1, max);

  return (
    <div className={`flex items-center gap-3 text-xs ${emphasis ? "text-helios-text" : ""}`}>
      <div className={`${labelClass} min-w-0 shrink-0 truncate`}>{label}</div>
      <div
        className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-helios-base"
        onMouseEnter={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          setHover({ x: b.left + Math.min(b.width, (b.width * total) / scale) / 2, y: b.top });
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${title ?? "Breakdown"}: ${segments.map((s) => `${s.value} ${s.label}`).join(", ")}`}
      >
        <div className="flex h-full" style={{ width: `${Math.min(100, (total / scale) * 100)}%` }}>
          {segments.map((s) =>
            s.value > 0 ? (
              <span
                key={s.key}
                className="h-full motion-safe:transition-opacity"
                style={{ width: `${(s.value / Math.max(1, total)) * 100}%`, backgroundColor: s.color }}
              />
            ) : null,
          )}
        </div>
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-3 font-mono tabular-nums">{trailing}</div> : null}
      {hover ? (
        <HoverTip
          x={hover.x}
          y={hover.y}
          title={title}
          rows={segments.map((s) => ({ label: s.label, value: s.value, swatch: s.color, muted: s.value === 0 }))}
          footer={`${total} total`}
        />
      ) : null}
    </div>
  );
}
