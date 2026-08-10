import type { ReactNode } from "react";
import type { WidgetType } from "../workspaces/types";

/* Tiny pictograms for the Add Tile palette — one per widget type, drawn as
 * 16×16 stroke icons on currentColor so they inherit the card's gold accent.
 * Deliberately schematic: each sketches the widget's silhouette (a zigzag for
 * the strip chart, an arc + needle for the round gauge) rather than trying to
 * be literal.
 */

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const ICONS: Record<WidgetType, ReactNode> = {
  strip_chart: (
    <path {...S} d="M1.5 11.5 L4.5 5.5 L7.5 9.5 L10.5 3.5 L14.5 8.5" />
  ),
  round_gauge: (
    <>
      <path {...S} d="M3 12.5 A 6 6 0 1 1 13 12.5" />
      <path {...S} d="M8 9.5 L5 5.5" />
    </>
  ),
  bar_gauge: (
    <>
      <rect {...S} x="5.5" y="1.5" width="5" height="13" />
      <path {...S} strokeWidth={5} d="M8 14 L8 8" opacity={0.55} />
      <path {...S} d="M3 5.5 L5.5 5.5" />
    </>
  ),
  numeric_readout: (
    <text
      x="8" y="12.5" textAnchor="middle" fill="currentColor" stroke="none"
      style={{ font: 'bold 11px "JetBrains Mono", ui-monospace, monospace' }}
    >
      42
    </text>
  ),
  engine_bar: (
    <>
      <path {...S} strokeWidth={2.2} d="M1.5 9 L1.5 13 M4.5 8 L4.5 13 M7.5 7 L7.5 13 M10.5 6 L10.5 13 M13.5 5 L13.5 13" />
      <path {...S} d="M12 2.5 L15 2.5" />
    </>
  ),
  gps_track: (
    <path {...S} d="M4.5 2.5 C 9 1.5, 14 3, 13.5 6.5 C 13 9.5, 8.5 8.5, 7 10.5 C 5.5 12.5, 10 14, 6.5 13.5 C 2 13, 1.5 9, 2.5 6 C 3 4, 3.5 3, 4.5 2.5 Z" />
  ),
  xy_plot: (
    <>
      <path {...S} d="M2.5 1.5 L2.5 13.5 L14.5 13.5" />
      <circle cx="6" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="4" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  histogram: (
    <path {...S} strokeWidth={2.4} d="M2.5 14 L2.5 10 M6 14 L6 5 M9.5 14 L9.5 2.5 M13 14 L13 8" />
  ),
  tire_grid: (
    <>
      <rect {...S} x="2" y="2" width="4.5" height="5" rx="1.5" />
      <rect {...S} x="9.5" y="2" width="4.5" height="5" rx="1.5" />
      <rect {...S} x="2" y="9" width="4.5" height="5" rx="1.5" />
      <rect {...S} x="9.5" y="9" width="4.5" height="5" rx="1.5" />
    </>
  ),
  lap_panel: (
    <>
      <path {...S} d="M5.5 3.5 L14 3.5 M5.5 8 L14 8 M5.5 12.5 L14 12.5" />
      <circle cx="2.75" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  alarm_panel: (
    <>
      <path {...S} d="M8 2 C 5.5 2, 4 4, 4 6.5 L4 9.5 L2.5 12 L13.5 12 L12 9.5 L12 6.5 C 12 4, 10.5 2, 8 2 Z" />
      <path {...S} d="M6.5 14 A 1.5 1.5 0 0 0 9.5 14" />
    </>
  ),
  steering_wheel: (
    <>
      <circle {...S} cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <path {...S} d="M8 9.2 L8 14 M6.9 7.5 L2.2 6.7 M9.1 7.5 L13.8 6.7" />
    </>
  ),
  channel_report: (
    <>
      <rect {...S} x="1.5" y="2.5" width="13" height="11" />
      <path {...S} d="M1.5 5.5 L14.5 5.5 M6 5.5 L6 13.5 M10.25 5.5 L10.25 13.5" />
    </>
  ),
  time_report: (
    <>
      <circle {...S} cx="8" cy="9" r="5.5" />
      <path {...S} d="M8 9 L8 5.5 M6.5 1.5 L9.5 1.5" />
    </>
  ),
  zone_stats: (
    <>
      <path {...S} d="M2.5 1.5 L2.5 14.5 M13.5 1.5 L13.5 14.5" />
      <path {...S} d="M5.5 5 L10.5 5 L7.5 8 L10.5 11 L5.5 11" />
    </>
  ),
  fft: (
    <path {...S} d="M1.5 13.5 L3 4 L4.5 13 L6 7 L7.5 12.5 L9 9 L10.5 12.5 L12 11 L14.5 13" />
  ),
  lap_delta: (
    <>
      <path {...S} strokeDasharray="2 2" d="M1.5 8 L14.5 8" />
      <path {...S} d="M1.5 8 C 3.5 4, 5.5 4.5, 7 8 C 8.5 11.5, 11 12, 14.5 8" />
    </>
  ),
  sector_table: (
    <>
      <circle {...S} cx="8" cy="8" r="6" />
      <path {...S} d="M8 8 L8 2 M8 8 L13.2 11 M8 8 L2.8 11" />
    </>
  ),
  values_table: (
    <>
      <rect {...S} x="1.5" y="2.5" width="13" height="11" />
      <path {...S} d="M6.5 2.5 L6.5 13.5 M1.5 8 L14.5 8" />
    </>
  ),
};

export function WidgetIcon({ type, className }: { type: WidgetType; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" className={className} aria-hidden>
      {ICONS[type]}
    </svg>
  );
}
