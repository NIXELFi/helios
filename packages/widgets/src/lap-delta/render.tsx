import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import uPlot, { type AlignedData, type Axis, type Options, type Scales, type Series } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { LapSelection } from "@helios/lib";
import { perSampleLapDistance } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { findSpeed } from "../lib/speed";
import { useResizeObserver } from "../lib/use-resize-observer";
import { computeLapDelta, formatDelta, type DeltaResult } from "./compute";

export interface LapDeltaConfig {
  /** Reserved for future per-widget tuning. Today the widget needs nothing
   *  beyond the global Main/Ref lap selection. */
  _placeholder?: never;
}

const POSITIVE_COLOR = "#EF5350"; // Main slower → red
const NEGATIVE_COLOR = "#66BB6A"; // Main faster → green
const ZERO_COLOR = "#5A5F66";

function formatDistance(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} km`;
  return `${v.toFixed(0)} m`;
}

export function LapDeltaRender(props: WidgetRenderProps<LapDeltaConfig>) {
  const { cursorEmitter, slice, timeRange, overlays, lapSelection, lapSelectionEmitter } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Live distance + Δ at the cursor — updated 60Hz from the cursor emitter
  // but only re-rendered when the values actually change (sub-pixel scrub
  // shouldn't churn React state).
  const cursorDistRef = useRef<number | null>(null);
  const cursorDeltaRef = useRef<number | null>(null);
  const [, tickCursor] = useReducer((x: number) => x + 1, 0);

  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];

  // Subscribe to lap selection emitter so picking a new Main/Ref in the lap
  // panel re-renders this widget immediately.
  const [liveSelection, setLiveSelection] = useState<LapSelection | undefined>(lapSelection);
  useEffect(() => {
    if (!lapSelectionEmitter) return;
    return lapSelectionEmitter.subscribe((s) => setLiveSelection(s));
  }, [lapSelectionEmitter]);

  // Resolve main/ref sessions + laps, compute the delta curve. Memoized on
  // the selection + visible-session-ids since neither is cheap.
  const visibleIdsKey = JSON.stringify(visible.map((v) => v.id));
  const selectionKey = JSON.stringify(liveSelection);
  const { result, message } = useMemo<{ result: DeltaResult | null; message: string | null }>(() => {
    const sel = liveSelection;
    if (!sel?.main) return { result: null, message: "Pick a Main lap (click in the Lap Panel)" };
    if (!sel.ref) return { result: null, message: "Pick a Ref lap to see Δt" };
    const mainSession = visible.find((o) => o.id === sel.main!.sessionId);
    const refSession = visible.find((o) => o.id === sel.ref!.sessionId);
    if (!mainSession || !mainSession.laps) return { result: null, message: "Main session has no detected laps" };
    if (!refSession || !refSession.laps) return { result: null, message: "Ref session has no detected laps" };
    const mainLap = mainSession.laps.laps[sel.main.lapIndex];
    const refLap = refSession.laps.laps[sel.ref.lapIndex];
    if (!mainLap || !refLap) return { result: null, message: "Selected lap index is out of range" };
    const mainSpeed = findSpeed(mainSession);
    const refSpeed = findSpeed(refSession);
    if (!mainSpeed || !refSpeed) return { result: null, message: "Sessions need a speed channel (gps.speed, vehicle.speed, …)" };
    const mainDist = perSampleLapDistance(mainSpeed.values, mainSpeed.unit, mainSession.slice.time, mainSession.laps);
    const refDist = perSampleLapDistance(refSpeed.values, refSpeed.unit, refSession.slice.time, refSession.laps);
    const r = computeLapDelta({
      mainTimeUs: mainSession.slice.time,
      mainDist,
      mainLapStartUs: mainLap.startUs,
      mainLapEndUs: mainLap.endUs,
      refTimeUs: refSession.slice.time,
      refDist,
      refLapStartUs: refLap.startUs,
      refLapEndUs: refLap.endUs,
    });
    if (!r) return { result: null, message: "Not enough data in the selected laps" };
    return { result: r, message: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, selectionKey, slice]);

  // Build aligned data + dual series (positive in red, negative in green).
  // uPlot can't gradient-color a single series cheaply, so we render two
  // NaN-masked traces — the negative one wins where delta < 0, the positive
  // one wins where delta > 0. Visually it reads as a band that flips color
  // at the zero line.
  const dataPack = useMemo<{ data: AlignedData; yMin: number; yMax: number }>(() => {
    if (!result) return { data: [new Float64Array(0)], yMin: -1, yMax: 1 };
    const pos = new Float64Array(result.deltaS.length);
    const neg = new Float64Array(result.deltaS.length);
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < result.deltaS.length; i++) {
      const d = result.deltaS[i]!;
      if (!Number.isFinite(d)) { pos[i] = NaN; neg[i] = NaN; continue; }
      pos[i] = d >= 0 ? d : NaN;
      neg[i] = d <= 0 ? d : NaN;
      if (d < yMin) yMin = d;
      if (d > yMax) yMax = d;
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = -1; yMax = 1; }
    // Pad the y range a touch so the trace doesn't kiss the chart edge.
    const span = Math.max(0.5, yMax - yMin);
    const pad = span * 0.1;
    return { data: [result.distance, pos, neg], yMin: yMin - pad, yMax: yMax + pad };
  }, [result]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!result) {
      plotRef.current?.destroy();
      plotRef.current = null;
      return;
    }
    const scales: Scales = { x: { time: false }, y: { range: [dataPack.yMin, dataPack.yMax] } };
    const axes: Axis[] = [
      {
        stroke: "#5A5F66",
        grid: { stroke: "#23252B" },
        values: (_u, splits) => splits.map(formatDistance),
        size: 30,
      },
      {
        stroke: "#5A5F66",
        grid: { stroke: "#23252B" },
        scale: "y",
        size: 45,
        values: (_u, splits) => splits.map((v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}` : "")),
      },
    ];
    const series: Series[] = [
      {},
      { stroke: POSITIVE_COLOR, width: 1.5, points: { show: false } },
      { stroke: NEGATIVE_COLOR, width: 1.5, points: { show: false } },
    ];
    const opts: Options = {
      width: containerRef.current.clientWidth || 600,
      height: containerRef.current.clientHeight || 200,
      pxAlign: 0,
      legend: { show: false },
      cursor: { show: false, drag: { x: false, y: false } },
      scales,
      axes,
      series,
      hooks: {
        draw: [(u) => {
          // Zero reference line drawn over the trace, dashed.
          const ctx = u.ctx;
          const yPx = u.valToPos(0, "y", true);
          ctx.save();
          ctx.strokeStyle = ZERO_COLOR;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, yPx);
          ctx.lineTo(u.bbox.left + u.bbox.width, yPx);
          ctx.stroke();
          ctx.restore();
        }],
      },
    };
    plotRef.current = new uPlot(opts, dataPack.data, containerRef.current);
    return () => { plotRef.current?.destroy(); plotRef.current = null; };
  }, [result, dataPack.yMin, dataPack.yMax, dataPack.data]);

  const onResize = useCallback(({ width, height }: { width: number; height: number }) => {
    const u = plotRef.current;
    if (!u) return;
    if (width > 0 && height > 0) u.setSize({ width, height });
  }, []);
  useResizeObserver(containerRef, onResize);

  // Project the global time-cursor onto this widget's distance axis. We
  // look up the Main session's distance at the current cursor time, then
  // draw a vertical line at that x on the plot and update the readout pill.
  // Subscribes once per (selection × visible) change so cursor scrubs while
  // selection is stable don't tear down + rebuild the listener.
  useEffect(() => {
    if (!result) {
      cursorDistRef.current = null;
      cursorDeltaRef.current = null;
      tickCursor();
      return;
    }
    const sel = liveSelection;
    if (!sel?.main) return;
    const mainSession = visible.find((o) => o.id === sel.main!.sessionId);
    if (!mainSession || !mainSession.laps) return;
    const mainLap = mainSession.laps.laps[sel.main.lapIndex];
    if (!mainLap) return;
    // Pre-compute the first sample index of the Main lap so we can map an
    // absolute-time cursor to result.{distance,deltaS} indices in O(1) per
    // emit (one binary search per cursor frame is fine). result is indexed
    // by (sampleIdx - lapStartIdx), where lapStartIdx is the first sample
    // whose time >= lap.startUs.
    const tArr = mainSession.slice.time;
    let lapStartIdx = 0, hi = tArr.length;
    while (lapStartIdx < hi) {
      const mid = (lapStartIdx + hi) >>> 1;
      if (Number(tArr[mid]!) < mainLap.startUs) lapStartIdx = mid + 1; else hi = mid;
    }
    const apply = (tUs: number) => {
      // Clamp to the Main lap window so cursor outside the lap pins to the
      // appropriate endpoint of the Δ trace.
      const clamped = Math.max(mainLap.startUs, Math.min(mainLap.endUs, tUs));
      // Binary search for the largest sampleIdx with time[sampleIdx] <= clamped.
      let lo = lapStartIdx, hh = tArr.length;
      while (lo < hh) {
        const mid = (lo + hh) >>> 1;
        if (Number(tArr[mid]!) <= clamped) lo = mid + 1; else hh = mid;
      }
      const sampleIdx = Math.max(lapStartIdx, lo - 1);
      const idxInResult = Math.min(result.distance.length - 1, Math.max(0, sampleIdx - lapStartIdx));
      const d = result.distance[idxInResult]!;
      const dt = result.deltaS[idxInResult]!;
      let changed = false;
      if (Number.isFinite(d) && d !== cursorDistRef.current) { cursorDistRef.current = d; changed = true; }
      if (Number.isFinite(dt) ? dt !== cursorDeltaRef.current : cursorDeltaRef.current !== null) {
        cursorDeltaRef.current = Number.isFinite(dt) ? dt : null;
        changed = true;
      }
      if (changed) {
        tickCursor();
        // Draw the cursor line directly via the uPlot canvas overlay; cheap.
        const u = plotRef.current;
        if (u && cursorDistRef.current !== null) {
          // We let uPlot's hooks.draw redraw the zero line on every redraw,
          // but the cursor line lives on a DOM child for per-frame updates
          // without triggering a full uPlot redraw.
          const over = u.over;
          let line = over.querySelector<HTMLDivElement>(".helios-lapdelta-cursor");
          if (!line) {
            line = document.createElement("div");
            line.className = "helios-lapdelta-cursor";
            line.style.position = "absolute";
            line.style.top = "0";
            line.style.bottom = "0";
            line.style.width = "1px";
            line.style.background = "#FFC627";
            line.style.pointerEvents = "none";
            over.appendChild(line);
          }
          const x = u.valToPos(cursorDistRef.current, "x", false);
          line.style.left = `${x}px`;
        }
      }
    };
    apply(cursorEmitter.get());
    return cursorEmitter.subscribe(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, selectionKey, visibleIdsKey, cursorEmitter]);

  const finalDelta = result?.finalDeltaS ?? NaN;
  const finalSign = Number.isFinite(finalDelta) ? (finalDelta > 0 ? "main-slower" : finalDelta < 0 ? "main-faster" : "tie") : "unknown";
  const finalColor = finalSign === "main-slower" ? POSITIVE_COLOR
    : finalSign === "main-faster" ? NEGATIVE_COLOR
    : "#D8DCE2";

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#16171B]">
      {/* Header readout — Main vs Ref labels, live cursor Δ, and total Δ.
          The cursor pill follows the global time cursor projected onto the
          Main lap's distance axis; it tells the user "at this moment in
          time, you were X seconds ahead/behind your reference lap." */}
      <div className="absolute top-1 left-1 z-10 pointer-events-none flex flex-row gap-1 items-center text-[9px]">
        <span className="bg-[#0E0E10cc] text-[#9097A0] px-1.5 py-px rounded-sm font-mono-num">
          Δt = Main − Ref
        </span>
        {cursorDeltaRef.current !== null && (
          <span
            className="bg-[#0E0E10cc] px-1.5 py-px rounded-sm font-mono-num tabular-nums"
            style={{ color: cursorDeltaRef.current > 0 ? POSITIVE_COLOR : cursorDeltaRef.current < 0 ? NEGATIVE_COLOR : "#D8DCE2" }}
            data-testid="lap-delta-cursor"
          >
            cursor {formatDelta(cursorDeltaRef.current)}
            {cursorDistRef.current !== null && (
              <span className="text-helios-dim ml-1">@{cursorDistRef.current >= 1000 ? `${(cursorDistRef.current / 1000).toFixed(2)}km` : `${cursorDistRef.current.toFixed(0)}m`}</span>
            )}
          </span>
        )}
        <span
          className="bg-[#0E0E10cc] px-1.5 py-px rounded-sm font-mono-num tabular-nums"
          style={{ color: finalColor }}
          data-testid="lap-delta-final"
        >
          final {formatDelta(finalDelta)}
        </span>
      </div>
      {message && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[#9097A0] text-center px-4 pointer-events-none">
          {message}
        </div>
      )}
    </div>
  );
}
