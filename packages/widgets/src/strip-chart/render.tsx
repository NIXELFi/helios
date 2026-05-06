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

    // Per-channel scales + alternating-side axes: channel 0 → left, 1 → right,
    // 2 → left (further out), 3 → right (further out), etc. Each axis takes
    // the channel's color so the user can read which trace owns which scale.
    const scales: Scales = { x: {} };
    const axes: Axis[] = [{ stroke: "#5A5F66", grid: { stroke: "#23252B" } }];
    for (let ci = 0; ci < config.channels.length; ci++) {
      const ch = config.channels[ci]!;
      const scaleId = `s${ci}`;
      const [lo, hi] = rangeFor(ch, config);
      scales[scaleId] = { range: [lo, hi] };
      axes.push({
        scale: scaleId,
        side: ci % 2 === 0 ? 3 : 1,  // 3 = left, 1 = right
        stroke: ch.color,
        // Only the first channel paints horizontal grid lines so the
        // background stays clean when channels have very different scales.
        grid: ci === 0 ? { stroke: "#23252B" } : { show: false, stroke: "" },
        size: 40,
      });
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
          scale: `s${meta.channelIndex}`,
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
      {/* In-canvas legend so it doesn't get clipped by the tile below. One
          row per channel, with a color chip and the channel id. */}
      {config.channels.length > 0 && (
        <div className="absolute top-1 left-1 flex flex-col gap-0.5 z-10 pointer-events-none">
          {config.channels.map((c, i) => {
            const [lo, hi] = rangeFor(c, config);
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 text-[10px] text-[#D8DCE2] bg-[#0E0E10cc] px-1.5 py-0.5 rounded-sm"
              >
                <span className="inline-block w-2 h-2" style={{ background: c.color }} />
                <span className="font-mono-num">{c.id || "—"}</span>
                <span className="text-[#7B8088]">{lo}…{hi}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
