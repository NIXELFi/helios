import { useCallback, useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Axis, type Options, type Scales, type Series } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface StripChartChannel {
  id: string;
  color: string;
  /** Per-channel Y range. When unset, falls back to the chart-level
   *  yMin/yMax. This is the MoTeC i2 model: each channel can have its
   *  own scale so a 0–14000 RPM trace and a 0–100 % throttle trace can
   *  share a chart without one being invisible. */
  yMin?: number;
  yMax?: number;
}

export interface StripChartConfig {
  channels: StripChartChannel[];
  /** Default Y range applied to channels that don't set their own. Kept
   *  for backward compatibility with single-scale charts. */
  yMin: number;
  yMax: number;
}

const DASH_PATTERNS: number[][] = [
  [], [6, 3], [2, 3], [10, 3, 2, 3], [4, 2],
];

function rangeFor(c: StripChartChannel, fallback: StripChartConfig): [number, number] {
  return [c.yMin ?? fallback.yMin, c.yMax ?? fallback.yMax];
}

/** Format an elapsed-seconds value as the time labels you'd expect on a
 *  motorsport chart: short laps stay sub-second precise, multi-minute
 *  stints fall back to M:SS. uPlot calls this for every tick. */
function formatElapsed(v: number): string {
  if (!Number.isFinite(v)) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const min = Math.floor(abs / 60);
  const sec = abs - min * 60;
  if (min === 0) {
    // Sub-minute — show seconds with one decimal at the start, plain int
    // once we're past the first few seconds.
    if (abs < 10) return `${sign}${sec.toFixed(1)}`;
    return `${sign}${Math.round(sec)}`;
  }
  return `${sign}${min}:${Math.round(sec).toString().padStart(2, "0")}`;
}

/** Build a uPlot AlignedData payload covering every visible session.
 *  X = sorted union of all session timestamps (in seconds).
 *  Each series is one (session × channel) pair, NaN where the session lacks
 *  a sample at that X. Returns metadata so the caller can label each series. */
function buildAlignedData(
  overlays: OverlaySession[],
  channels: StripChartChannel[],
): { data: AlignedData; seriesMeta: Array<{ session: OverlaySession; channelIndex: number }> } {
  if (overlays.length === 0) {
    return { data: [new Float64Array(0)], seriesMeta: [] };
  }
  const xSet = new Set<number>();
  for (const o of overlays) {
    const t = o.slice.time;
    for (let i = 0; i < t.length; i++) xSet.add(Number(t[i]) / 1_000_000);
  }
  const x = Float64Array.from([...xSet].sort((a, b) => a - b));
  const xIndex = new Map<number, number>();
  for (let i = 0; i < x.length; i++) xIndex.set(x[i]!, i);

  const ys: Float64Array[] = [];
  const seriesMeta: Array<{ session: OverlaySession; channelIndex: number }> = [];
  for (const session of overlays) {
    for (let ci = 0; ci < channels.length; ci++) {
      const arr = session.slice.data.get(channels[ci]!.id);
      const y = new Float64Array(x.length);
      y.fill(NaN);
      if (arr) {
        const t = session.slice.time;
        for (let i = 0; i < t.length; i++) {
          const tS = Number(t[i]) / 1_000_000;
          const idx = xIndex.get(tS);
          if (idx !== undefined) y[idx] = arr[i]!;
        }
      }
      ys.push(y);
      seriesMeta.push({ session, channelIndex: ci });
    }
  }
  return { data: [x, ...ys], seriesMeta };
}

export function StripChartRender(props: WidgetRenderProps<StripChartConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Fall back to a synthetic single-overlay representation if no overlays were
  // supplied (e.g. tests that pre-date the multi-session API).
  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];
  const isMulti = visible.length > 1;

  useEffect(() => {
    if (!containerRef.current) return;
    const { data, seriesMeta } = buildAlignedData(visible, config.channels);

    // Group channels by their resolved Y range so channels that share a
    // range share an axis. Without this, four shock channels at the same
    // ±25 mm range would each get their own axis and the outer axes
    // would clip at the tile edge. The first distinct range goes on the
    // left, the second on the right; channels beyond that share the
    // closest-matching existing axis (no third side, no triple-stacked
    // axes that overflow the tile).
    // X is elapsed time-in-seconds, NOT Unix epoch. Without this uPlot would
    // format ticks as wall-clock dates (e.g. "12/31/69 5pm" for a value of 0
    // in the local timezone). time: false flips it to a plain numeric scale,
    // and the axis values formatter below renders M:SS / SS.s / etc.
    const scales: Scales = { x: { time: false } };
    const axes: Axis[] = [{
      stroke: "#5A5F66",
      grid: { stroke: "#23252B" },
      values: (_u, splits) => splits.map(formatElapsed),
      // Time axis at the bottom needs enough vertical room for the labels.
      size: 30,
    }];
    /** scaleId per channel index, threaded into series below */
    const channelScale: string[] = [];
    /** ordered list of unique [lo, hi, scaleId, color, side] */
    const groups: Array<{ lo: number; hi: number; id: string; color: string; side: 1 | 3 }> = [];
    for (let ci = 0; ci < config.channels.length; ci++) {
      const ch = config.channels[ci]!;
      const [lo, hi] = rangeFor(ch, config);
      let group = groups.find((g) => g.lo === lo && g.hi === hi);
      if (!group) {
        const id = `s${groups.length}`;
        const side: 1 | 3 = groups.length === 0 ? 3 : 1;
        // First two distinct ranges get their own axis; further distinct
        // ranges share the closer side's axis (range will be wrong but
        // the trace still draws — the legend tells the user the actual
        // channel range so this degradation is acceptable).
        group = { lo, hi, id, color: ch.color, side };
        groups.push(group);
        if (groups.length <= 2) {
          scales[id] = { range: [lo, hi] };
          axes.push({
            scale: id,
            side,
            stroke: ch.color,
            // Only the left axis paints grid lines so the background
            // stays clean when ranges differ.
            grid: side === 3 ? { stroke: "#23252B" } : { show: false, stroke: "" },
            // 60 px gives 5-digit labels like "15,000" room to breathe;
            // 40 was clipping the leading comma on RPM-scale charts.
            size: 60,
          });
        } else {
          // Fall back to the first group's scale.
          group.id = groups[0]!.id;
        }
      }
      channelScale.push(group.id);
    }

    const series: Series[] = [
      {},
      ...seriesMeta.map((meta): Series => {
        // Single session: keep configured channel colors so multi-channel
        // charts (e.g. RPM + throttle) stay visually distinct.
        // Multiple sessions: use the session color so the overlay reads as
        // "lap A vs lap B"; channels within a session are separated by dash.
        const stroke = isMulti ? meta.session.color : config.channels[meta.channelIndex]!.color;
        const dash = isMulti && config.channels.length > 1
          ? DASH_PATTERNS[meta.channelIndex % DASH_PATTERNS.length]!
          : [];
        return {
          stroke,
          width: 1,
          dash: dash.length ? dash : undefined,
          scale: channelScale[meta.channelIndex] ?? "s0",
          // Disable point markers; we draw our own cursor line instead.
          points: { show: false },
        };
      }),
    ];

    const opts: Options = {
      width: containerRef.current.clientWidth || 600,
      height: containerRef.current.clientHeight || 200,
      pxAlign: 0,
      // uPlot's default legend renders an HTML table below the canvas which
      // gets clipped by neighboring tiles. Disable it; we draw our own
      // overlay legend in the React tree (see JSX below).
      legend: { show: false },
      cursor: { show: false, drag: { x: false, y: false }, sync: undefined, points: { show: false } },
      scales,
      axes,
      series,
    };

    let cleanupPointer: (() => void) | undefined;
    try {
      plotRef.current?.destroy();
      plotRef.current = new uPlot(opts, data, containerRef.current);
      const u = plotRef.current;
      const over = u.over;
      over.style.cursor = "crosshair";

      let dragging = false;
      const emitFromEvent = (e: PointerEvent) => {
        const rect = over.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const tS = u.posToVal(localX, "x");
        cursorEmitter.emit(Math.round(tS * 1_000_000));
      };
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        dragging = true;
        over.setPointerCapture(e.pointerId);
        emitFromEvent(e);
      };
      const onMove = (e: PointerEvent) => { if (dragging) emitFromEvent(e); };
      const onUp = (e: PointerEvent) => {
        dragging = false;
        if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
      };
      over.addEventListener("pointerdown", onDown);
      over.addEventListener("pointermove", onMove);
      over.addEventListener("pointerup", onUp);
      over.addEventListener("pointercancel", onUp);
      cleanupPointer = () => {
        over.removeEventListener("pointerdown", onDown);
        over.removeEventListener("pointermove", onMove);
        over.removeEventListener("pointerup", onUp);
        over.removeEventListener("pointercancel", onUp);
      };
    } catch (_e) {
      // jsdom canvas may not support 2d context; ignore in test environments
    }

    return () => {
      cleanupPointer?.();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, config, timeRange, cursorEmitter, JSON.stringify(visible.map((v) => v.id))]);

  useEffect(() => {
    const off = cursorEmitter.subscribe((tUs) => {
      const u = plotRef.current; if (!u) return;
      const tS = tUs / 1_000_000;
      const left = u.valToPos(tS, "x", false);
      const over = u.over;
      let line = over.querySelector<HTMLDivElement>(".helios-cursor");
      if (!line) {
        line = document.createElement("div");
        line.className = "helios-cursor";
        line.style.position = "absolute";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = "1px";
        line.style.background = "#FFC627";
        line.style.pointerEvents = "none";
        over.appendChild(line);
      }
      line.style.left = `${left}px`;
    });
    return off;
  }, [cursorEmitter]);

  // Resize the existing uPlot instance when the container changes size, rather
  // than rebuilding the chart. setSize takes CSS pixels.
  const onResize = useCallback(({ width, height }: { width: number; height: number }) => {
    const u = plotRef.current;
    if (!u) return;
    if (width > 0 && height > 0) u.setSize({ width, height });
  }, []);
  useResizeObserver(containerRef, onResize);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#16171B]">
      {/* Compact in-canvas legend: single horizontal row in the top-right
          so it doesn't overlap the data on the leading edge of a scrub.
          Color chip + channel id only — the per-axis tick labels already
          tell the user the range, so we don't duplicate that info. */}
      {config.channels.length > 0 && (
        <div className="absolute top-1 right-1 flex flex-row gap-1 z-10 pointer-events-none max-w-[80%] flex-wrap justify-end">
          {config.channels.map((c, i) => (
            <div
              key={i}
              className="flex items-center gap-1 text-[9px] text-[#D8DCE2] bg-[#0E0E10cc] px-1 py-px rounded-sm"
            >
              <span className="inline-block w-1.5 h-1.5" style={{ background: c.color }} />
              <span className="font-mono-num leading-none">{c.id || "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
