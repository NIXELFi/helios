"use client";

import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// The one tooltip every Productivity chart shares. Rendered through a portal
// to document.body (the pattern Select uses) so an overflow-hidden panel never
// clips it, and clamped to the viewport like TaskPeekCard. Pure presentation:
// the chart owns the hover state and hands over an anchor point in viewport
// coordinates.
// ---------------------------------------------------------------------------

export interface HoverTipRow {
  label: string;
  value: string | number;
  swatch?: string | null;
  /** Dim the row (e.g. a series with zero in this column). */
  muted?: boolean;
}

export interface HoverTipProps {
  /** Viewport x/y of the anchor. The tip sits above it, centred, flipping below when there is no room. */
  x: number;
  y: number;
  title?: string;
  rows: ReadonlyArray<HoverTipRow>;
  /** Small trailing line under the rows. */
  footer?: string;
}

const TIP_W = 200;
const TIP_MAX_H = 260;
const GAP = 10;

export function HoverTip({ x, y, title, rows, footer }: HoverTipProps) {
  if (typeof document === "undefined") return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(x - TIP_W / 2, vw - TIP_W - 8));
  // Above the anchor by default; below when the anchor is near the top edge.
  const flip = y - TIP_MAX_H - GAP < 0 && y + GAP + TIP_MAX_H < vh;
  const style: React.CSSProperties = flip
    ? { left, top: y + GAP, width: TIP_W }
    : { left, bottom: vh - y + GAP, width: TIP_W };

  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] rounded-md border border-helios-line bg-helios-panel px-2.5 py-2 text-xs shadow-lg"
      style={style}
    >
      {title ? (
        <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">{title}</div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {rows.map((r, i) => (
          <li
            key={`${r.label}-${i}`}
            className={`flex items-center gap-1.5 ${r.muted ? "text-helios-dim/60" : "text-helios-text"}`}
          >
            {r.swatch ? (
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.swatch }} />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="shrink-0 font-mono tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
      {footer ? <div className="mt-1 text-[10px] text-helios-dim">{footer}</div> : null}
    </div>,
    document.body,
  );
}
