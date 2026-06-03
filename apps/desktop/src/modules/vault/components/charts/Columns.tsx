import { EmptyChart } from "./ChartCard";
import type { Column } from "../../lib/vaultStats";

/** Vertical column histogram — a row of proportional bars with labels beneath.
 *  Div-based and flexible; every column shares `accent`. Pass `labelEvery` to
 *  thin dense x-axis labels (e.g. months) so they don't overlap. */
export function Columns({
  data,
  accent = "#FFC627",
  formatValue = (v) => v.toLocaleString(),
  labelEvery = 1,
}: {
  data: Column[];
  accent?: string;
  formatValue?: (v: number) => string;
  labelEvery?: number;
}) {
  if (data.length === 0) return <EmptyChart />;
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="flex h-40 items-end gap-1">
      {data.map((d, i) => {
        const h = (d.value / max) * 100;
        const showLabel = i % labelEvery === 0 || i === data.length - 1;
        return (
          <div key={d.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t-sm transition-all hover:opacity-80"
                style={{ height: `${Math.max(h, d.value > 0 ? 3 : 0)}%`, backgroundColor: accent }}
                title={`${d.label}: ${formatValue(d.value)}`}
              />
            </div>
            <span className="h-3 w-full truncate text-center text-[8px] leading-3 text-helios-dim">
              {showLabel ? d.label : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
