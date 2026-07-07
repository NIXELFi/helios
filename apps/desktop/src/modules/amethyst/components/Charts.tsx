export interface BarDatum {
  label: string;
  value: number;
  secondary?: number; // optional stacked second series
  color?: string;
  onClick?: () => void;
}

/**
 * Horizontal bar chart, div-based (responsive, no SVG math, theme-aware).
 * Optional `secondary` stacks a second series (e.g. notes + figures).
 */
export function BarChart({
  data,
  primaryLabel,
  secondaryLabel,
  accent = "#FFC627",
  accent2 = "#8C1D40",
}: {
  data: BarDatum[];
  primaryLabel?: string;
  secondaryLabel?: string;
  accent?: string;
  accent2?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value + (d.secondary ?? 0)));
  return (
    <div>
      {(primaryLabel || secondaryLabel) && (
        <div className="mb-2 flex items-center gap-3 text-[11px] text-helios-dim">
          {primaryLabel && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: accent }} />
              {primaryLabel}
            </span>
          )}
          {secondaryLabel && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: accent2 }} />
              {secondaryLabel}
            </span>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        {data.map((d) => {
          const total = d.value + (d.secondary ?? 0);
          const Comp = d.onClick ? "button" : "div";
          return (
            <Comp
              key={d.label}
              onClick={d.onClick}
              className={
                "flex w-full items-center gap-2 text-left " +
                (d.onClick ? "group cursor-pointer" : "")
              }
            >
              <span className="w-32 shrink-0 truncate text-xs text-helios-dim group-hover:text-helios-text">
                {d.label}
              </span>
              <span className="relative h-4 flex-1 overflow-hidden rounded bg-helios-line/40">
                <span
                  className="absolute inset-y-0 left-0 rounded-l transition-all"
                  style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? accent }}
                />
                {d.secondary !== undefined && (
                  <span
                    className="absolute inset-y-0"
                    style={{
                      left: `${(d.value / max) * 100}%`,
                      width: `${(d.secondary / max) * 100}%`,
                      background: accent2,
                    }}
                  />
                )}
              </span>
              <span className="w-8 shrink-0 text-right text-xs tabular-nums text-helios-text">{total}</span>
            </Comp>
          );
        })}
      </div>
    </div>
  );
}
