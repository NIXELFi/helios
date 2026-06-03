// Shared helpers for the Vault Insights charts. No charting library is used —
// the charts are hand-rolled SVG (matching the CFD ParallelCoordsPlot / PM
// Gantt convention), so these utilities keep colors, number, and byte
// formatting consistent across every chart.

/** Categorical palette tuned for the dark Helios theme. Index 0 is asu-gold so
 *  the primary series always reads as the brand accent. */
export const CHART_PALETTE = [
  "#FFC627", // asu-gold
  "#4FC3F7", // sky
  "#81C784", // green
  "#BA68C8", // purple
  "#FF8A65", // coral
  "#4DB6AC", // teal
  "#F06292", // pink
  "#FFD54F", // amber
  "#9575CD", // violet
  "#A1887F", // taupe
  "#90A4AE", // blue-grey
] as const;

export function colorAt(i: number): string {
  return CHART_PALETTE[i % CHART_PALETTE.length]!;
}

/** Human-readable byte size: 0 B, 932 B, 4.3 KB, 1.6 MB, 2.04 GB. Binary (1024)
 *  units to match how PDM/SolidWorks file sizes are usually quoted. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const e = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, e);
  const digits = e === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(digits)} ${units[e]}`;
}

/** Thousands-separated integer (1,234). */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Truncate a long label to the middle so both ends stay readable — useful for
 *  file names where the extension matters: "VeryLongAssemblyNa…Rev_12.SLDASM". */
export function ellipsizeMiddle(s: string, max = 28): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
