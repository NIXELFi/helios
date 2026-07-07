export interface BarDatum {
  label: string;
  value: number;
  secondary?: number; // optional second series (e.g. figures), shown alongside
  color?: string;
  onClick?: () => void;
}

/**
 * Horizontal bar chart, div-based (responsive, theme-aware). `secondary`
 * renders a second series segment after the primary one.
 */
export function BarChart({
  data,
  primaryLabel,
  secondaryLabel,
  accent = "#FFC627",
  accent2 = "#4E86B0",
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
        <div className="mb-3 flex items-center gap-4 text-[11px] text-helios-dim">
          {primaryLabel && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} />
              {primaryLabel}
            </span>
          )}
          {secondaryLabel && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent2 }} />
              {secondaryLabel}
            </span>
          )}
        </div>
      )}
      <div className="space-y-2.5">
        {data.map((d) => {
          const total = d.value + (d.secondary ?? 0);
          const Comp = d.onClick ? "button" : "div";
          return (
            <Comp
              key={d.label}
              onClick={d.onClick}
              className={"flex w-full items-center gap-3 text-left " + (d.onClick ? "group cursor-pointer" : "")}
            >
              <span className="w-28 shrink-0 truncate text-xs text-helios-dim transition-colors group-hover:text-helios-text">
                {d.label}
              </span>
              <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-helios-line/25">
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                  style={{ width: `${((d.value + (d.secondary ?? 0)) / max) * 100}%`, background: accent2, opacity: d.secondary !== undefined ? 1 : 0 }}
                />
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                  style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? accent }}
                />
              </span>
              <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-helios-text">{total}</span>
            </Comp>
          );
        })}
      </div>
    </div>
  );
}
