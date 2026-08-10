/* Pure logic for the Values table widget: metadata resolution, value/delta
 * formatting, and primary-session window stats. Split out of render.tsx so the
 * formatting and stats rules are unit-testable without mounting the widget.
 */
import type { ChannelSlice } from "@helios/store";
import { aggregateZone } from "../zone-stats/compute";

// displayMeta/formatValue grew out of this widget and are now shared by every
// widget that names a channel; re-exported so this module's surface (and its
// tests) stay stable.
export { displayMeta, formatValue, type DisplayMeta } from "../lib/display-meta";

export type DeltaTint = "pos" | "neg" | "zero";

/** Sign classification for the Δ-vs-primary cells, matching the footer's
 *  lap-compare Δ (App.tsx): neutral when the delta rounds to zero at the
 *  channel's display precision — 0.5·10^-decimals is exactly the footer's
 *  ±0.005 threshold at its 2-decimal display. */
export function deltaTint(d: number | null, decimals: number): DeltaTint {
  if (d === null || !Number.isFinite(d)) return "zero";
  const eps = 0.5 * Math.pow(10, -decimals);
  return d >= eps ? "pos" : d <= -eps ? "neg" : "zero";
}

/** Signed fixed-point delta. Display-zero deltas render unsigned (a "+0.00"
 *  reads like real data); missing deltas render "—". Uses the true minus sign
 *  to match the time report and footer. */
export function formatDelta(d: number | null, decimals: number): string {
  if (d === null || !Number.isFinite(d)) return "—";
  if (deltaTint(d, decimals) === "zero") return (0).toFixed(decimals);
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(decimals)}`;
}

export interface ChannelStats {
  min: number;
  max: number;
  avg: number;
  n: number;
}

/** min / max / avg for one channel over `[startUs, endUs]`. Null when the
 *  channel is absent from the slice or the window holds no finite samples.
 *  Delegates the window search + accumulation to zone-stats' aggregateZone
 *  (binary-searched bounds, NaN samples skipped). */
export function channelStats(
  slice: Pick<ChannelSlice, "time" | "data">,
  channelId: string,
  startUs: number,
  endUs: number,
): ChannelStats | null {
  const arr = slice.data.get(channelId);
  if (!arr) return null;
  const agg = aggregateZone(arr, slice.time, startUs, endUs);
  if (agg.n === 0) return null;
  return { min: agg.min, max: agg.max, avg: agg.sum / agg.n, n: agg.n };
}
