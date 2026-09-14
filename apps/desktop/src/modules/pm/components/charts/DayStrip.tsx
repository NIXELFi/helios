// ---------------------------------------------------------------------------
// DayStrip: seven tiny columns, Monday to Sunday, for "which day of this week
// does the crunch land on". Today's column is drawn in the text colour so the
// eye finds it; the rest in the dim tone. Same fixed-slot contract as the
// Sparkline — it lives beside a KPI value.
// ---------------------------------------------------------------------------

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

export interface DayStripProps {
  /** Seven counts, Monday first. */
  values: ReadonlyArray<number>;
  /** 0 = Monday … 6 = Sunday. */
  todayIndex: number;
  label: string;
  width?: number;
  height?: number;
}

export function DayStrip({ values, todayIndex, label, width = 88, height = 24 }: DayStripProps) {
  const max = Math.max(1, ...values);
  const slot = width / 7;
  const barW = Math.max(3, slot * 0.6);
  const plotH = height - 8;
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
      {values.slice(0, 7).map((v, i) => {
        const h = (v / max) * plotH;
        const x = i * slot + (slot - barW) / 2;
        const isToday = i === todayIndex;
        return (
          <g key={i}>
            <rect
              x={x}
              y={plotH - h}
              width={barW}
              height={h}
              className={isToday ? "fill-asu-gold" : "fill-helios-dim/50"}
            />
            <text
              x={i * slot + slot / 2}
              y={height}
              textAnchor="middle"
              className={`text-[8px] ${isToday ? "fill-helios-text" : "fill-helios-dim/70"}`}
            >
              {DAY_LETTERS[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
