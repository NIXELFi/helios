import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";
import type { XyPlotConfig, PlotLayout, OverlayContext, SessionGroup } from "./types";
import { buildSessionGroups } from "./data-pipeline";
import { getOverlayModule } from "./overlays/registry";
// Side-effect imports: each overlay self-registers on load.
import "./overlays/scatter";
import "./overlays/fit";
import "./overlays/formula";

/* Re-export for back-compat with `import type { XyPlotConfig } from "./render"`. */
export type { XyPlotConfig } from "./types";

export function XyPlotRender(props: WidgetRenderProps<XyPlotConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays: visibleOverlays, viewState } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<{ groups: SessionGroup[]; layout: PlotLayout } | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const markerDrawRef = useRef<() => void>(() => {});

  const visible: OverlaySession[] = visibleOverlays && visibleOverlays.length > 0
    ? visibleOverlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];

  drawRef.current = () => draw();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    drawRef.current();
    markerDrawRef.current();
  }, [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  const onResize = useCallback(() => {
    drawRef.current();
    markerDrawRef.current();
  }, []);
  useResizeObserver(canvasRef, onResize);

  // Pointer scrub on the marker canvas. Closest-point lookup against the
  // currently rendered groups (cached in layoutRef).
  useEffect(() => {
    const c = markerCanvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const layout = layoutRef.current; if (!layout || layout.groups.length === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let bestT = 0, bestD = Infinity;
      for (const g of layout.groups) {
        for (let i = 0; i < g.n; i++) {
          const { px, py } = layout.layout.project(g.xs[i]!, g.ys[i]!);
          const dx = px - mx, dy = py - my;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestT = g.time[i]!; }
        }
      }
      cursorEmitter.emit(Math.round(bestT));
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true; c.setPointerCapture(e.pointerId); emitFromEvent(e);
    };
    const onMove = (e: PointerEvent) => { if (dragging) emitFromEvent(e); };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
    };
  }, [cursorEmitter]);

  // Marker layer (cursor ring + crosshair + datum markers).
  useEffect(() => {
    const drawMarkers = () => {
      const layout = layoutRef.current;
      const c = markerCanvasRef.current; if (!c) return;
      const ctx = setupCanvas(c);
      const { w, h } = canvasLogicalSize(c);
      ctx.clearRect(0, 0, w, h);
      if (!layout || layout.groups.length === 0) return;
      drawCursorAndDatums(ctx, layout.layout, layout.groups, cursorEmitter.get(), viewState?.get().datums ?? []);
    };
    markerDrawRef.current = drawMarkers;
    drawMarkers();
    const offCursor = cursorEmitter.subscribe(drawMarkers);
    const offView = viewState?.subscribe(drawMarkers);
    return () => { offCursor(); offView?.(); };
  }, [cursorEmitter, viewState]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const groups = buildSessionGroups(visible, {
      xChannelId: config.xChannelId,
      yChannelId: config.yChannelId,
      filter: config.filter,
      groupByChannelId: config.groupByChannelId,
      zoomRange: viewState?.get().zoomRange ?? null,
    });

    if (groups.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      layoutRef.current = null;
      return;
    }

    let xmin = config.xMin, xmax = config.xMax, ymin = config.yMin, ymax = config.yMax;
    if (xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined) {
      let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity;
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const xv = g.xs[i]!, yv = g.ys[i]!;
          if (xv < xn) xn = xv; if (xv > xx) xx = xv;
          if (yv < yn) yn = yv; if (yv > yx) yx = yv;
        }
      }
      xmin = xmin ?? xn; xmax = xmax ?? xx; ymin = ymin ?? yn; ymax = ymax ?? yx;
    }
    const padL = 28, padR = 8, padT = 18, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xSpan = Math.max(1e-9, xmax! - xmin!);
    const ySpan = Math.max(1e-9, ymax! - ymin!);
    const layout: PlotLayout = {
      xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax!,
      padL, padT, plotW, plotH,
      project(x, y) {
        return {
          px: padL + ((x - xmin!) / xSpan) * plotW,
          py: padT + plotH - ((y - ymin!) / ySpan) * plotH,
        };
      },
    };
    layoutRef.current = { groups, layout };

    // Frame + zero crosshair
    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);
    ctx.strokeStyle = "#5A5F66";
    ctx.beginPath();
    if (xmin! < 0 && xmax! > 0) {
      const x0 = layout.project(0, 0).px;
      ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH);
    }
    if (ymin! < 0 && ymax! > 0) {
      const y0 = layout.project(0, 0).py;
      ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0);
    }
    ctx.stroke();

    // Iterate overlays in array order. Skip unknown kinds with a warn.
    const ctxObj: OverlayContext = {
      bounds: { xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax! },
      priorArtifacts: new Map(),
      availableChannels: [],
    };
    const priorArtifacts = ctxObj.priorArtifacts as Map<string, unknown>;
    for (const overlay of config.overlays) {
      const mod = getOverlayModule(overlay.kind);
      if (!mod) { console.warn(`xy-plot: unknown overlay kind '${overlay.kind}'`); continue; }
      if (config.mode === "simple" && !mod.availability.includes("simple")) continue;
      const artifacts = mod.compute(groups, overlay.config as never, ctxObj);
      priorArtifacts.set(overlay.id, artifacts);
      mod.draw?.(ctx, layout, artifacts, overlay.config as never);
    }

    // Axis labels
    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${config.xChannelId} × ${config.yChannelId}`, 4, 4);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(xmin!.toFixed(1), padL, h - 4);
    ctx.textAlign = "right";
    ctx.fillText(xmax!.toFixed(1), w - padR, h - 4);
    ctx.save();
    ctx.translate(10, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`${ymin!.toFixed(1)} → ${ymax!.toFixed(1)}`, 0, 0);
    ctx.restore();
  }

  return (
    <div className="relative w-full h-full bg-[#16171B]">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={markerCanvasRef} className="absolute inset-0 w-full h-full cursor-crosshair" />
    </div>
  );
}

/* Cursor + datum markers — extracted out of the main render. */
function drawCursorAndDatums(
  ctx: CanvasRenderingContext2D,
  layout: PlotLayout,
  groups: SessionGroup[],
  cursorUs: number,
  datums: number[],
): void {
  const { padL, padT, plotW, plotH, project } = layout;
  for (const tUs of datums) {
    for (const g of groups) {
      const idx = indexAtTime(g.time, tUs);
      if (idx === null) continue;
      const x = g.xs[idx], y = g.ys[idx];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const { px, py } = project(x, y);
      ctx.strokeStyle = "rgba(255, 107, 74, 0.35)"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py);
      ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = "#FF6B4A"; ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }
  for (const g of groups) {
    const xy = interpolatedAt(g.time, g.xs, g.ys, cursorUs);
    if (!xy) continue;
    const { px, py } = project(xy.x, xy.y);
    ctx.strokeStyle = "rgba(232, 234, 238, 0.45)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py);
    ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH);
    ctx.stroke();
    ctx.strokeStyle = "#E8EAEE"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
  }
}

function indexAtTime(time: Float64Array, tUs: number): number | null {
  if (time.length === 0) return null;
  let lo = 0, hi = time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time[mid]! <= tUs) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function interpolatedAt(
  time: Float64Array, xs: Float64Array, ys: Float64Array, tUs: number,
): { x: number; y: number } | null {
  if (time.length === 0) return null;
  const idx = indexAtTime(time, tUs);
  if (idx === null) return null;
  const x0 = xs[idx]!, y0 = ys[idx]!;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  if (idx + 1 >= time.length) return { x: x0, y: y0 };
  const x1 = xs[idx + 1]!, y1 = ys[idx + 1]!;
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return { x: x0, y: y0 };
  const t0 = time[idx]!, t1 = time[idx + 1]!;
  const span = t1 - t0;
  if (span <= 0) return { x: x0, y: y0 };
  const f = Math.max(0, Math.min(1, (tUs - t0) / span));
  return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
}
