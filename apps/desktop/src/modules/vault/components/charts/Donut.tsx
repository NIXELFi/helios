import { colorAt } from "../../lib/chart-utils";
import { EmptyChart } from "./ChartCard";
import type { Slice } from "../../lib/vaultStats";

/** SVG donut chart with a side legend. Uses the stroke-dasharray technique (one
 *  <circle> per slice) rather than arc paths — crisp at any size and trivial to
 *  reason about. `formatExtra` renders the secondary metric (e.g. bytes) in the
 *  legend when a slice carries one. */
export function Donut({
  data,
  centerLabel,
  formatExtra,
}: {
  data: Slice[];
  centerLabel?: string;
  formatExtra?: (extra: number) => string;
}) {
  const total = data.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <EmptyChart />;

  const R = 56;
  const STROKE = 22;
  const C = 2 * Math.PI * R;
  let acc = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0" role="img" aria-label="Donut chart">
        <g transform="rotate(-90 70 70)">
          {data.map((s, i) => {
            const frac = s.value / total;
            const len = frac * C;
            const el = (
              <circle
                key={s.label}
                cx={70}
                cy={70}
                r={R}
                fill="none"
                stroke={colorAt(i)}
                strokeWidth={STROKE}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-acc}
              >
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            acc += len;
            return el;
          })}
        </g>
        <text x={70} y={66} textAnchor="middle" className="fill-helios-text" fontSize={20} fontWeight={600}>
          {total.toLocaleString()}
        </text>
        {centerLabel ? (
          <text x={70} y={82} textAnchor="middle" className="fill-helios-dim" fontSize={9}>
            {centerLabel}
          </text>
        ) : null}
      </svg>
      <ul className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {data.map((s, i) => {
          const pct = Math.round((s.value / total) * 100);
          return (
            <li key={s.label} className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorAt(i) }} />
              <span className="min-w-0 flex-1 truncate text-helios-text" title={s.label}>{s.label}</span>
              <span className="shrink-0 tabular-nums text-helios-dim">
                {s.value}
                <span className="ml-1 text-helios-dim/70">{pct}%</span>
                {formatExtra && s.extra != null ? (
                  <span className="ml-2 text-helios-dim/60">{formatExtra(s.extra)}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
