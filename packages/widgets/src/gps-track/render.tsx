import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface GpsTrackConfig {
  latChannelId: string;
  lonChannelId: string;
  /** optional: color the track by this channel's value */
  colorByChannelId?: string;
  /** when colorBy is set: gradient stops min..max */
  colorMin?: number;
  colorMax?: number;
}

export function GpsTrackRender(props: WidgetRenderProps<GpsTrackConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef<number>(cursorEmitter.get());
  const projRef = useRef<{ xs: Float64Array; ys: Float64Array; n: number } | null>(null);

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      tRef.current = t;
      draw();
    });
    return off;
  }, [cursorEmitter]);

  useEffect(() => { draw(); }, [slice, config]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const proj = projRef.current; if (!proj || proj.n === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = rect.width, h = rect.height;
      const pad = 16;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < proj.n; i++) {
        const dx = (pad + proj.xs[i]! * (w - pad * 2)) - mx;
        const dy = (pad + proj.ys[i]! * (h - pad * 2)) - my;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      const tUs = Number(slice.time[best] ?? 0n);
      cursorEmitter.emit(tUs);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      c.setPointerCapture(e.pointerId);
      emitFromEvent(e);
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
  }, [cursorEmitter, slice]);

  function projectAll(): { xs: Float64Array; ys: Float64Array; n: number } | null {
    const lat = slice.data.get(config.latChannelId);
    const lon = slice.data.get(config.lonChannelId);
    if (!lat || !lon) return null;
    const n = Math.min(lat.length, lon.length);
    if (n === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < n; i++) {
      const la = lat[i]!, lo = lon[i]!;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    }
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (lon[i]! - minLon) / Math.max(1e-12, maxLon - minLon);
      ys[i] = 1 - (lat[i]! - minLat) / Math.max(1e-12, maxLat - minLat);
    }
    return { xs, ys, n };
  }

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);
    const proj = projectAll();
    projRef.current = proj;
    if (!proj) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no GPS data", w / 2, h / 2);
      return;
    }
    const { xs, ys, n } = proj;
    const pad = 16;
    const px = (i: number) => pad + xs[i]! * (w - pad * 2);
    const py = (i: number) => pad + ys[i]! * (h - pad * 2);

    const colorBy = config.colorByChannelId ? slice.data.get(config.colorByChannelId) : undefined;
    if (colorBy && config.colorMin !== undefined && config.colorMax !== undefined) {
      const span = config.colorMax - config.colorMin;
      ctx.lineWidth = 2.5;
      for (let i = 1; i < n; i++) {
        const t = Math.max(0, Math.min(1, ((colorBy[i] ?? 0) - config.colorMin) / span));
        ctx.strokeStyle = lerpColor("#26A69A", "#FFB800", t);
        ctx.beginPath();
        ctx.moveTo(px(i - 1), py(i - 1));
        ctx.lineTo(px(i), py(i));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "#4FC3F7"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(i));
      ctx.stroke();
    }

    // Car dot at cursor
    const t = BigInt(tRef.current);
    let lo = 0, hi = slice.time.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (slice.time[mid]! <= t) lo = mid + 1; else hi = mid;
    }
    const idx = Math.max(0, Math.min(n - 1, lo - 1));
    const cx = pad + xs[idx]! * (w - pad * 2);
    const cy = pad + ys[idx]! * (h - pad * 2);
    ctx.fillStyle = "#FFC627";
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`GPS · ${n} pts${config.colorByChannelId ? ` · ${config.colorByChannelId}` : ""}`, 6, 6);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B] cursor-crosshair" />;
}

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = hex2(aHex), b = hex2(bHex);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex2(h: string) {
  const v = parseInt(h.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}
