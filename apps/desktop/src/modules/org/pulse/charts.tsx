import { useMemo, useRef, useState, type ReactNode } from "react";
import { DOW_LABELS, niceMax, type Point } from "./pulse-lib";

import { tc, tca } from "@helios/ui";
// Chart primitives for Admin > Pulse. Hand-rolled SVG like the Vault Insights
// charts (no library), but with a hover layer: every plotted chart answers
// "what is this exact value" on pointer-over, and the text always wears the
// text tokens - the series color only ever tints marks.

export const C = {
  gold: "#FFC627",
  info: "#42A5F5",
  success: "#66BB6A",
  danger: "#EF5350",
  warn: "#F5A623",
  violet: "#B39DDB",
  line: tc("line"),
  dim: tc("dim"),
  text: tc("text"),
};

/** Panel wrapper - same border/title treatment as the Insights ChartCard so
 *  the two dashboards read as one family. */
export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"flex min-w-0 flex-col border border-helios-line bg-helios-panel " + className}>
      <header className="flex items-start justify-between gap-2 border-b border-helios-line px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-helios-text">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[10px] text-helios-dim">{subtitle}</p> : null}
        </div>
        {right}
      </header>
      <div className="min-w-0 flex-1 p-3">{children}</div>
    </section>
  );
}

export function Empty({ message = "No data yet" }: { message?: string }) {
  return (
    <div className="flex h-full min-h-[96px] items-center justify-center text-xs text-helios-dim">{message}</div>
  );
}

/** Tiny inline trend line for the KPI tiles. */
export function Sparkline({ points, accent = C.gold }: { points: Point[]; accent?: string }) {
  // Hooks first: the empty-state return below must not change the hook count
  // between renders (a 1-point series growing to 2 would otherwise throw).
  const id = useMemo(() => `spk-${Math.random().toString(36).slice(2, 8)}`, []);
  if (points.length < 2) return <div className="h-8" />;
  const W = 120;
  const H = 32;
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = Math.max(max - min, 1);
  const n = points.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / span) * (H - 4);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity={0.28} />
          <stop offset="100%" stopColor={accent} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={accent} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Headline number with a delta and a sparkline underneath. */
export function Kpi({
  label,
  value,
  delta,
  hint,
  points,
  accent = C.gold,
  live,
}: {
  label: string;
  value: string;
  delta?: { text: string; tone: "up" | "down" | "flat" } | null;
  hint?: string;
  points?: Point[];
  accent?: string;
  live?: boolean;
}) {
  const toneCls = delta?.tone === "up" ? "text-helios-success" : delta?.tone === "down" ? "text-helios-danger" : "text-helios-dim";
  return (
    <div className="flex min-w-0 flex-col border border-helios-line bg-helios-panel px-3 pb-2 pt-2.5">
      <div className="flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-widest text-helios-dim">
        {live ? <span className="pulse-dot" aria-hidden /> : null}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono-num text-2xl font-semibold tabular-nums text-helios-text">{value}</span>
        {delta ? <span className={"font-mono-num text-[11px] tabular-nums " + toneCls}>{delta.text}</span> : null}
      </div>
      {hint ? <div className="text-[10px] text-helios-dim/80">{hint}</div> : null}
      {points ? (
        <div className="mt-1.5">
          <Sparkline points={points} accent={accent} />
        </div>
      ) : null}
    </div>
  );
}

interface Hover {
  i: number;
  px: number; // pointer x in px within the chart box (for the tooltip)
}

function useHover(n: number) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const onMove = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const px = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    const i = n === 1 ? 0 : Math.round((px / r.width) * (n - 1));
    // Only re-render when the hovered index changes; pointermove fires at
    // display rate and a 365-column chart is ~1k nodes.
    setHover((h) => (h && h.i === i ? h : { i, px }));
  };
  return { box, hover, onMove, clear: () => setHover(null) };
}

function Tooltip({ px, width, children }: { px: number; width: number; children: ReactNode }) {
  // Flip to the left half when near the right edge so it never clips.
  const left = px > width * 0.65;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 whitespace-nowrap border border-helios-line bg-helios-base/95 px-2 py-1 text-[10px] text-helios-text shadow-lg"
      style={left ? { right: width - px + 8 } : { left: px + 8 }}
    >
      {children}
    </div>
  );
}

/** Single-series area + line with crosshair tooltip and a light y-grid. */
export function AreaChart({
  points,
  accent = C.gold,
  format = (v: number) => v.toLocaleString(),
  height = 200,
}: {
  points: Point[];
  accent?: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const { box, hover, onMove, clear } = useHover(points.length);
  const id = useMemo(() => `area-${Math.random().toString(36).slice(2, 8)}`, []);
  if (points.length === 0) return <Empty />;
  const W = 600;
  const H = height;
  const PAD_L = 4;
  const PAD_R = 4;
  const PAD_T = 8;
  const PAD_B = 18;
  const top = niceMax(Math.max(...points.map((p) => p.value), 1));
  const n = points.length;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${(H - PAD_B).toFixed(1)} ${line} ${x(n - 1).toFixed(1)},${(H - PAD_B).toFixed(1)}`;
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const boxW = box.current?.getBoundingClientRect().width ?? W;
  const hp = hover ? points[hover.i] : null;

  return (
    <div ref={box} className="relative select-none" onPointerMove={onMove} onPointerLeave={clear}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Growth over time">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.3} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <line key={t} x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={`url(#${id})`} />
        <polyline points={line} fill="none" stroke={accent} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hover ? (
          <>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD_T} y2={H - PAD_B} stroke={C.dim} strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover.i)} cy={y(points[hover.i]!.value)} r={4} fill={accent} stroke={tc("panel")} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        ) : (
          <circle cx={x(n - 1)} cy={y(points[n - 1]!.value)} r={3} fill={accent} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* Axis labels live in HTML so they never stretch with the viewBox. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between py-1 pr-1 text-[9px] text-helios-dim/80">
        <span>{format(top)}</span>
        <span>{format(top / 2)}</span>
        <span className="mb-4">0</span>
      </div>
      <div className="flex justify-between text-[9px] text-helios-dim">
        {points.map((p, i) => (
          <span key={p.iso} className="min-w-0 flex-1 truncate text-center first:text-left last:text-right">
            {i % labelEvery === 0 || i === n - 1 ? p.label : ""}
          </span>
        ))}
      </div>
      {hp && hover ? (
        <Tooltip px={hover.px} width={boxW}>
          <span className="text-helios-dim">{hp.iso}</span>
          <span className="ml-2 font-mono-num tabular-nums">{format(hp.value)}</span>
        </Tooltip>
      ) : null}
    </div>
  );
}

export interface StackSeries {
  key: string;
  label: string;
  color: string;
  points: Point[];
}

/** Stacked daily columns for the activity-by-module chart, with a legend
 *  (>= 2 series) and a per-column tooltip listing every series. An optional
 *  overlay line (e.g. 7-day mean) is drawn on the same axis. */
export function StackedColumns({
  series,
  overlay,
  overlayLabel,
  height = 180,
  format = (v: number) => v.toLocaleString(),
}: {
  series: StackSeries[];
  overlay?: Point[];
  overlayLabel?: string;
  height?: number;
  format?: (v: number) => string;
}) {
  const n = series[0]?.points.length ?? 0;
  const { box, hover, onMove, clear } = useHover(n);
  if (n === 0) return <Empty />;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.points[i]?.value ?? 0), 0));
  const top = niceMax(Math.max(...totals, ...(overlay?.map((p) => p.value) ?? []), 1));
  const W = 600;
  const H = height;
  const PAD_B = 18;
  const PAD_T = 6;
  const slot = W / n;
  const gap = Math.min(2, slot * 0.2);
  const bw = Math.max(slot - gap, 1);
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const boxW = box.current?.getBoundingClientRect().width ?? W;
  const first = series[0]!.points;

  return (
    <div className="flex flex-col gap-2">
      <div ref={box} className="relative select-none" onPointerMove={onMove} onPointerLeave={clear}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Activity per day">
          {[0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={y(f * top)} y2={y(f * top)} stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {first.map((_, i) => {
            let acc = 0;
            const x0 = i * slot + gap / 2;
            const dimmed = hover && hover.i !== i;
            return (
              <g key={first[i]!.iso} opacity={dimmed ? 0.55 : 1}>
                {series.map((s) => {
                  const v = s.points[i]?.value ?? 0;
                  if (v <= 0) return null;
                  const y1 = y(acc + v);
                  const y0 = y(acc);
                  acc += v;
                  // 1px surface gap between stacked segments (spacer rule).
                  return <rect key={s.key} x={x0} y={y1} width={bw} height={Math.max(y0 - y1 - 1, 0.5)} fill={s.color} />;
                })}
              </g>
            );
          })}
          {overlay ? (
            <polyline
              points={overlay.map((p, i) => `${(i * slot + slot / 2).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")}
              fill="none"
              stroke={C.text}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between py-0.5 pr-1 text-[9px] text-helios-dim/80">
          <span>{format(top)}</span>
          <span className="mb-4">0</span>
        </div>
        <div className="flex justify-between text-[9px] text-helios-dim">
          {first.map((p, i) => (
            <span key={p.iso} className="min-w-0 flex-1 truncate text-center first:text-left last:text-right">
              {i % labelEvery === 0 || i === n - 1 ? p.label : ""}
            </span>
          ))}
        </div>
        {hover ? (
          <Tooltip px={hover.px} width={boxW}>
            <div className="text-helios-dim">{first[hover.i]!.iso}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block size-2" style={{ backgroundColor: s.color }} />
                <span className="w-16 text-helios-dim">{s.label}</span>
                <span className="font-mono-num tabular-nums">{format(s.points[hover.i]?.value ?? 0)}</span>
              </div>
            ))}
            {overlay && overlayLabel ? (
              <div className="mt-0.5 border-t border-helios-line pt-0.5 text-helios-dim">
                {overlayLabel}: <span className="font-mono-num tabular-nums text-helios-text">{format(Math.round(overlay[hover.i]?.value ?? 0))}</span>
              </div>
            ) : null}
          </Tooltip>
        ) : null}
      </div>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} extra={overlayLabel ? [{ label: overlayLabel, dashed: true }] : []} />
    </div>
  );
}

export function Legend({ items, extra = [] }: { items: Array<{ label: string; color: string }>; extra?: Array<{ label: string; dashed?: boolean }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-helios-dim">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
      {extra.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0 w-3 border-t border-dashed border-helios-text" />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Simple vertical columns (single series) with hover tooltip. */
export function ColumnChart({
  points,
  accent = C.info,
  height = 160,
  format = (v: number) => v.toLocaleString(),
  overlay,
  overlayLabel,
}: {
  points: Point[];
  accent?: string;
  height?: number;
  format?: (v: number) => string;
  overlay?: Point[];
  overlayLabel?: string;
}) {
  return (
    <StackedColumns
      series={[{ key: "v", label: "", color: accent, points }]}
      overlay={overlay}
      overlayLabel={overlayLabel}
      height={height}
      format={format}
    />
  );
}

/** 7 x 24 activity heatmap: one hue (gold), light to dark by magnitude. */
export function Heatmap({ grid, hourLabel = (h: number) => `${h}:00` }: { grid: number[][]; hourLabel?: (h: number) => string }) {
  const max = Math.max(1, ...grid.flat());
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const total = grid.flat().reduce((a, b) => a + b, 0);
  if (total === 0) return <Empty message="No activity in the last 30 days" />;
  return (
    <div className="flex flex-col gap-1">
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}>
        {grid.map((row, d) => (
          <div key={d} className="contents">
            <div className="pr-1 text-right text-[9px] leading-[14px] text-helios-dim">{DOW_LABELS[d]}</div>
            {row.map((v, h) => {
              const t = v / max;
              const alpha = v === 0 ? 0.06 : 0.18 + 0.82 * Math.sqrt(t);
              const isHover = hover?.d === d && hover?.h === h;
              return (
                <div
                  key={h}
                  className="h-[14px] min-w-0"
                  style={{
                    backgroundColor: `${tca("gold", alpha)}`,
                    outline: isHover ? `1px solid ${C.text}` : undefined,
                    outlineOffset: -1,
                  }}
                  onPointerEnter={() => setHover({ d, h })}
                  onPointerLeave={() => setHover(null)}
                  title={`${DOW_LABELS[d]} ${hourLabel(h)}: ${v} action${v === 1 ? "" : "s"}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="grid gap-[2px] text-[8px] text-helios-dim" style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="truncate text-center">
            {h % 6 === 0 ? hourLabel(h) : ""}
          </span>
        ))}
      </div>
      <div className="text-[10px] text-helios-dim">
        {hover ? (
          <>
            {DOW_LABELS[hover.d]} {hourLabel(hover.h)}: <span className="font-mono-num text-helios-text">{grid[hover.d]![hover.h]}</span> actions
          </>
        ) : (
          "Hover a cell. Local time. Vault, PM and games actions over the last 30 days."
        )}
      </div>
    </div>
  );
}

/** Horizontal proportional bars with a value column. */
export function Bars({
  rows,
  accent = C.gold,
  format = (v: number) => v.toLocaleString(),
}: {
  rows: Array<{ label: string; value: number; sub?: string }>;
  accent?: string;
  format?: (v: number) => string;
}) {
  if (rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[88px_1fr_64px] items-center gap-2 text-[11px]">
          <span className="truncate text-helios-text" title={r.label}>{r.label}</span>
          <div className="h-3 w-full bg-helios-base">
            <div className="h-3" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: accent }} title={format(r.value)} />
          </div>
          <span className="text-right font-mono-num tabular-nums text-helios-dim">
            {format(r.value)}
            {r.sub ? <span className="ml-1 text-helios-dim/60">{r.sub}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
