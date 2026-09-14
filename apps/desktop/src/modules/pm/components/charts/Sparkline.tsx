// ---------------------------------------------------------------------------
// Sparkline: a 7-12 point mini area with no axes, the last point dotted. Lives
// inside a KPI tile to say "and here is the shape of the last few weeks"
// without competing with the number. Fixed pixel size — it never needs to be
// measured because the tile gives it a fixed slot.
// ---------------------------------------------------------------------------

export interface SparklineProps {
  values: ReadonlyArray<number>;
  width?: number;
  height?: number;
  /** Accessible description, e.g. "Completions over the last 12 weeks". */
  label: string;
}

export function Sparkline({ values, width = 88, height = 24, label }: SparklineProps) {
  const n = values.length;
  if (n === 0) return null;
  const max = Math.max(1, ...values);
  const padY = 3;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * (width - 2) + 1);
  const y = (v: number) => height - padY - (v / max) * (height - padY * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${x(n - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const lastX = x(n - 1);
  const lastY = y(values[n - 1]!);

  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
      <path d={area} className="fill-asu-gold/15" />
      <path d={line} className="stroke-asu-gold/80" fill="none" strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2} className="fill-asu-gold" />
    </svg>
  );
}
