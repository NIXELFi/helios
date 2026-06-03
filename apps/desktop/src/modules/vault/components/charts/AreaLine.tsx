import { EmptyChart } from "./ChartCard";
import type { Column } from "../../lib/vaultStats";

/** Single-series area + line chart for a monotonic/cumulative series (e.g. vault
 *  growth). SVG with a non-uniform-scaling viewBox so it stretches to the card.
 *  The final value is labeled; first/last x-labels anchor the timeline. */
export function AreaLine({
  data,
  accent = "#FFC627",
  formatValue = (v) => v.toLocaleString(),
}: {
  data: Column[];
  accent?: string;
  formatValue?: (v: number) => string;
}) {
  if (data.length === 0) return <EmptyChart />;

  const W = 320;
  const H = 120;
  const PAD = 4;
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);

  const line = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${H} ${line} ${x(n - 1).toFixed(1)},${H}`;
  const last = data[n - 1]!;

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Growth area chart">
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#area-grad)" />
        <polyline points={line} fill="none" stroke={accent} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <circle cx={x(n - 1)} cy={y(last.value)} r={2.5} fill={accent} />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-helios-dim">
        <span>{data[0]!.label}</span>
        <span className="tabular-nums text-helios-text">{formatValue(last.value)} total</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}
