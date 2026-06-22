// Generic XY line plot built on uPlot. Used by sweep curves, P-V loops,
// pipe profiles. Title + legend rendered outside the canvas so Helios
// chrome stays consistent across charts. ResizeObserver-driven.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface LineSeries {
  label: string;
  /** Y values aligned to `x` (or to the series' own `x` if `xs` is set). */
  y: number[];
  /** Optional per-series X — defaults to the chart-level `xs`. */
  xs?: number[];
  color?: string;
  axis?: "y" | "y2";
  /** Render points (default: auto — on if <40 pts/series). */
  showPoints?: boolean;
  width?: number;
}

interface LinePlotProps {
  title: string;
  /** Shared X axis when individual series don't provide their own xs. */
  xs?: number[];
  series: LineSeries[];
  xLabel?: string;
  yLabel?: string;
  y2Label?: string;
  yLog?: boolean;
  xLog?: boolean;
  height?: number;
  /** Enable click-drag zoom on the X axis (Y stays auto). Default: true.
   *  A "Reset zoom" affordance appears in the header once the user zooms. */
  zoomable?: boolean;
}

const DEFAULT_COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1", "#CE93D8", "#FF8A65"];

export function LinePlot({
  title, xs, series,
  xLabel, yLabel, y2Label,
  yLog = false, xLog = false,
  height = 220,
  zoomable = true,
}: LinePlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const plotHostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Whether the user has drag-zoomed away from the full x extent. Drives the
  // "Reset zoom" affordance; cleared on reset and on any plot rebuild.
  const [zoomed, setZoomed] = useState(false);

  // Structural key — rebuild plot when series shape changes OR when
  // data arrives for the first time. The "ready" suffix is critical:
  // uPlot's setData() auto-scale doesn't always catch a 0→N length
  // jump cleanly, so we force a fresh `new uPlot(...)` when the first
  // real data lands. Subsequent data updates flow through the cheap
  // setData() path.
  const dataReady = (xs?.length ?? 0) > 0
    || series.some((s) => (s.xs?.length ?? 0) > 0 || s.y.length > 0);

  // X extent across all data. The plot pins its x range at creation (uPlot's
  // post-setData auto-scale is flaky — see scales.x below), so the extent MUST
  // be part of the rebuild key: when the same-shaped series swap to data over
  // a different domain (e.g. the Lap Sim screen toggling between the ~0.8 km
  // autocross and the ~1.3 km endurance lap), the axis has to rebuild — it
  // can't follow via setData against a pinned range.
  let xMin = Infinity, xMax = -Infinity;
  const scanX = (vals: number[] | undefined) => {
    if (!vals) return;
    for (const v of vals) {
      if (Number.isFinite(v)) {
        if (v < xMin) xMin = v;
        if (v > xMax) xMax = v;
      }
    }
  };
  scanX(xs);
  for (const s of series) scanX(s.xs);
  const haveXRange = isFinite(xMin) && isFinite(xMax) && xMax > xMin;
  const xRange = haveXRange ? ([xMin, xMax] as [number, number]) : undefined;
  // Full-extent x range captured for the "Reset zoom" affordance — restoring
  // this via setScale("x", ...) returns the chart to its un-zoomed domain.
  const fullXRangeRef = useRef<[number, number] | null>(null);
  fullXRangeRef.current = xRange ?? null;

  function resetZoom() {
    const r = fullXRangeRef.current;
    if (r && plotRef.current) {
      plotRef.current.setScale("x", { min: r[0], max: r[1] });
    }
    setZoomed(false);
  }

  // showPoints/width are structural — they're baked into the uPlot series at
  // create time, so they MUST be part of the rebuild key or a toggle leaves the
  // chart rendering with the stale options.
  const fieldKey = `ready=${dataReady}|x=${haveXRange ? `${xMin}:${xMax}` : "auto"}|` + series.map((s) =>
    `${s.label}:${s.color ?? ""}:${s.axis ?? "y"}:${s.xs ? "own" : "shared"}:${s.showPoints ?? "auto"}:${s.width ?? "auto"}`
  ).join("|");

  // Build aligned uPlot data. If any series carries its own xs, we must
  // build a per-series (x,y) pair via the gaps trick. Simplest: pad each
  // series onto the union of all xs. Since uPlot aligned data wants a
  // single x axis, when series have their own x we render each via a
  // *separate* plot pass. For Phase 3 we never mix shared-x + per-series-x
  // in the same chart — assert here.
  function buildData(): uPlot.AlignedData {
    const anyOwnX = series.some((s) => s.xs);
    if (anyOwnX) {
      // Merge all xs into a sorted unique union, then build per-series y
      // arrays by lookup (linear search — counts are small).
      const allXs = new Set<number>();
      for (const s of series) {
        const xsForS = s.xs ?? xs ?? [];
        for (const x of xsForS) allXs.add(x);
      }
      const xUnion = Array.from(allXs).sort((a, b) => a - b);
      // Gaps must be null (uPlot's missing-value sentinel), NOT NaN: with NaN,
      // disjoint grids (e.g. comparing a sweep to an optimization best on an
      // offset rpm grid) interleave so EVERY neighbor is a gap and uPlot draws
      // no segments at all — a blank chart. null + spanGaps (set on the series
      // below) connects each series across the other grids' points.
      const cols: (number | null)[][] = series.map((s) => {
        const sx = s.xs ?? xs ?? [];
        // Dedup policy: a series may carry repeated x values (e.g. two trials
        // sampled at the same rpm). uPlot's aligned data is keyed by x, so a
        // duplicate must collapse to one y — we keep the FIRST sample at each x
        // (set only when absent) rather than letting a later, possibly stale or
        // unsorted, sample silently overwrite it.
        const map = new Map<number, number>();
        for (let i = 0; i < sx.length; i++) {
          const x = sx[i] as number;
          if (!map.has(x)) map.set(x, s.y[i] as number);
        }
        return xUnion.map((x) => (map.has(x) ? (map.get(x) as number) : null));
      });
      return [xUnion, ...cols] as uPlot.AlignedData;
    }
    const xsShared = xs ?? [];
    return [xsShared, ...series.map((s) => s.y)];
  }

  useLayoutEffect(() => {
    if (!plotHostRef.current) return;
    const usesY2 = series.some((s) => s.axis === "y2");

    const axisStroke = "#5A5F66";
    const gridStroke = "#23252B";
    const labelFont = "10px ui-sans-serif, system-ui, sans-serif";
    const valueFont = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const baseAxis: Partial<uPlot.Axis> = {
      stroke: axisStroke,
      grid: { stroke: gridStroke },
      ticks: { stroke: gridStroke, size: 4 },
      font: valueFont, labelFont,
      size: 30, labelGap: 2,
    };

    const totalPts = series.reduce((acc, s) => acc + s.y.length, 0);
    // Explicit X range (xRange, computed above with the rebuild key) — uPlot's
    // auto-scale can be flaky when series have their own xs (overlay/compare
    // path) or when the initial render starts with empty data and updates
    // later. Pinning it here + rebuilding when the extent changes keeps the
    // axis correct in BOTH directions.
    const opts: uPlot.Options = {
      width: plotHostRef.current.clientWidth || 400,
      height: Math.max(height - 28, 80),
      pxAlign: 0,
      scales: {
        x: {
          time: false,
          distr: xLog ? 3 : 1,
          // Pin range explicitly when we have data so uPlot's
          // post-setData auto-scale logic can't get stuck.
          ...(xRange ? { range: xRange } : { auto: true }),
        },
        y: { auto: true, distr: yLog ? 3 : 1 },
        ...(usesY2 ? { y2: { auto: true } } : {}),
      },
      axes: [
        { ...baseAxis, label: xLabel ?? "", size: 24 } as uPlot.Axis,
        { ...baseAxis, label: yLabel ?? "", size: 44 } as uPlot.Axis,
        ...(usesY2
          ? [{ ...baseAxis, label: y2Label ?? "", scale: "y2", side: 1, size: 44, grid: { show: false, stroke: "" } } as uPlot.Axis]
          : []),
      ],
      series: [
        { label: xLabel ?? "x" },
        ...series.map((s, i): uPlot.Series => ({
          label: s.label,
          stroke: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
          width: s.width ?? 1.5,
          points: { show: s.showPoints ?? (totalPts < 40 * series.length), size: 5 },
          // Own-x series are padded onto the x union with null gaps — span them
          // or the line breaks at every other grid's sample (see buildData).
          ...(s.xs ? { spanGaps: true } : {}),
          scale: s.axis === "y2" ? "y2" : "y",
        })),
      ],
      legend: { show: false },
      // X-axis drag-zoom (Y stays auto so vertical extent is never clipped).
      // A small "Reset zoom" button (rendered in the header below) restores the
      // full extent via setScale; the setScale hook tracks whether we're zoomed.
      cursor: { drag: { x: zoomable, y: false }, points: { show: true, size: 5 } },
      hooks: zoomable
        ? {
            setScale: [
              (u: uPlot, key: string) => {
                if (key !== "x") return;
                const full = fullXRangeRef.current;
                const sx = u.scales.x;
                if (!full || !sx || sx.min == null || sx.max == null) return;
                // Treat a near-full domain as "not zoomed" (float slack).
                const span = full[1] - full[0] || 1;
                const eps = span * 1e-6;
                const atFull = sx.min <= full[0] + eps && sx.max >= full[1] - eps;
                setZoomed(!atFull);
              },
            ],
          }
        : {},
      padding: [10, 12, 4, 4],
    };

    plotRef.current?.destroy();
    try {
      plotRef.current = new uPlot(opts, buildData(), plotHostRef.current);
    } catch (e) {
      // uPlot can throw on degenerate data shapes (e.g. mismatched
      // series lengths during a transient render). Don't let the
      // failure propagate up and unmount the whole results page.
      // eslint-disable-next-line no-console
      console.warn("LinePlot uPlot create failed:", e);
      plotRef.current = null;
    }

    // A fresh plot starts at the full extent — clear any stale zoomed flag so a
    // leftover "Reset zoom" button doesn't persist across a rebuild (study
    // switch, new sweep point, overlay toggle).
    setZoomed(false);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, xLabel, yLabel, y2Label, yLog, xLog, height, zoomable]);

  useEffect(() => {
    try {
      plotRef.current?.setData(buildData());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("LinePlot setData failed:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, series]);

  useEffect(() => {
    const host = plotHostRef.current;
    if (!host) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        plotRef.current?.setSize({ width: Math.max(cr.width, 80), height: Math.max(cr.height, 80) });
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
        <div className="flex flex-wrap items-center gap-2">
          {zoomable && zoomed && (
            <button
              type="button"
              aria-label="Reset zoom"
              onClick={resetZoom}
              className="rounded-sm border border-[#FFC627]/40 px-1.5 py-[1px] text-[9px] uppercase tracking-wider text-[#FFC627] hover:bg-[#FFC627]/10"
            >
              Reset zoom
            </button>
          )}
          {series.map((s, i) => (
            <span key={s.label + i} className="flex items-center gap-1 text-[10px] text-[#5A5F66]">
              <span
                className="inline-block h-[2px] w-3"
                style={{ background: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length] }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      {/* uPlot draws to canvas, which is invisible to assistive tech — name
          the chart region so screen readers announce what the canvas shows. */}
      <div
        ref={plotHostRef}
        role="img"
        aria-label={`${title} chart: ${series.map((s) => s.label).join(", ")}`}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
