import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface XyPlotConfig {
  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;
  color: string;
  /** if true, color points by their time index (time-color trail) */
  trail: boolean;
}

export function XyPlotRender(props: WidgetRenderProps<XyPlotConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<{
    xs: Float64Array; ys: Float64Array; n: number;
    xmin: number; xmax: number; ymin: number; ymax: number;
    padL: number; padT: number; plotW: number; plotH: number;
  } | null>(null);

  useEffect(() => { draw(); }, [slice, config]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const layout = layoutRef.current; if (!layout || layout.n === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { xs, ys, n, xmin, xmax, ymin, ymax, padL, padT, plotW, plotH } = layout;
      const xSpan = Math.max(1e-9, xmax - xmin);
      const ySpan = Math.max(1e-9, ymax - ymin);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const px = padL + ((xs[i]! - xmin) / xSpan) * plotW;
        const py = padT + plotH - ((ys[i]! - ymin) / ySpan) * plotH;
        const dx = px - mx, dy = py - my;
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

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const xs = slice.data.get(config.xChannelId);
    const ys = slice.data.get(config.yChannelId);
    if (!xs || !ys || xs.length === 0 || ys.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }
    const n = Math.min(xs.length, ys.length);

    let xmin = config.xMin, xmax = config.xMax, ymin = config.yMin, ymax = config.yMax;
    if (xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined) {
      let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity;
      for (let i = 0; i < n; i++) {
        const xv = xs[i]!, yv = ys[i]!;
        if (xv < xn) xn = xv; if (xv > xx) xx = xv;
        if (yv < yn) yn = yv; if (yv > yx) yx = yv;
      }
      xmin = xmin ?? xn; xmax = xmax ?? xx; ymin = ymin ?? yn; ymax = ymax ?? yx;
    }
    const padL = 28, padR = 8, padT = 18, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xScale = (v: number) => padL + ((v - xmin!) / Math.max(1e-9, xmax! - xmin!)) * plotW;
    const yScale = (v: number) => padT + plotH - ((v - ymin!) / Math.max(1e-9, ymax! - ymin!)) * plotH;
    layoutRef.current = {
      xs, ys, n,
      xmin: xmin!, xmax: xmax!, ymin: ymin!, ymax: ymax!,
      padL, padT, plotW, plotH,
    };

    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);
    ctx.strokeStyle = "#5A5F66";
    ctx.beginPath();
    if (xmin! < 0 && xmax! > 0) {
      const x0 = xScale(0); ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH);
    }
    if (ymin! < 0 && ymax! > 0) {
      const y0 = yScale(0); ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0);
    }
    ctx.stroke();

    if (config.trail) {
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        ctx.fillStyle = lerpColor("#26A69A", "#FFB800", t);
        ctx.fillRect(xScale(xs[i]!) - 1, yScale(ys[i]!) - 1, 2, 2);
      }
    } else {
      ctx.fillStyle = config.color;
      for (let i = 0; i < n; i++) ctx.fillRect(xScale(xs[i]!) - 1, yScale(ys[i]!) - 1, 2, 2);
    }

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
