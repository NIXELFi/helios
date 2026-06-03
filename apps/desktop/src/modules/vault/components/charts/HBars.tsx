import { colorAt } from "../../lib/chart-utils";
import { EmptyChart } from "./ChartCard";
import type { Bar } from "../../lib/vaultStats";

/** Horizontal bar list — label on the left, a proportional fill, value on the
 *  right. Div-based (not SVG) so it reflows with the card width. `accent` keeps
 *  every bar one color (e.g. storage); omit it to color bars categorically. */
export function HBars({
  data,
  formatValue = (v) => v.toLocaleString(),
  accent,
}: {
  data: Bar[];
  formatValue?: (v: number) => string;
  accent?: string;
}) {
  if (data.length === 0) return <EmptyChart />;
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <ul className="flex flex-col gap-2">
      {data.map((d, i) => {
        const pct = Math.max((d.value / max) * 100, 1.5);
        const color = accent ?? colorAt(i);
        return (
          <li key={d.label} className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 truncate text-helios-text" title={d.sublabel ? `${d.label} — ${d.sublabel}` : d.label}>
              {d.label}
            </span>
            <span className="relative h-3.5 flex-1 overflow-hidden bg-helios-base">
              <span
                className="absolute inset-y-0 left-0"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-helios-dim">{formatValue(d.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}
