// Dedicated canvas-based renderer for engine P-V loops. uPlot is
// optimized for monotonic-X time-series data; P-V loops have
// non-monotonic V (the piston sweeps through V_clearance → V_max
// twice per 720° cycle) and the standard line drawing artifacts make
// the loop unrecognizable. This component draws the loop directly
// by tracing through points in their stored order (which is
// crank-angle ordered, i.e. the natural cycle progression).

import { useEffect, useLayoutEffect, useRef } from "react";

interface Props {
  title: string;
  /** Cell-center positions on the x axis. Each pair (V[i], P[i]) is
   * one sample on the loop. Must be in cycle order. */
  V: number[];
  /** Pressure at each sample, paired with V[i]. */
  P: number[];
  vUnits?: string;          // default "cc"
  pUnits?: string;          // default "bar"
  /** Log-P toggle. */
  logP?: boolean;
  color?: string;
  height?: number;
}

const AXIS_COLOR = "#5A5F66";
const GRID_COLOR = "#23252B";
const LABEL_COLOR = "#9097A0";
const TICK_COLOR = "#5A5F66";

export function PvLoopChart({
  title, V, P, vUnits = "cc", pUnits = "bar",
  logP = false, color = "#FFC627", height = 260,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Render the loop. Re-runs whenever data, sizing, or scale changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;

    function draw() {
      if (!canvas) return;
      const cssW = (canvas.parentElement?.clientWidth ?? 400);
      const cssH = Math.max(height - 28 /* title strip */, 80);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.max(2, Math.floor(cssW * dpr));
      canvas.height = Math.max(2, Math.floor(cssH * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (V.length === 0 || P.length === 0 || V.length !== P.length) {
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText("(no data)", 8, 20);
        return;
      }

      // Find data ranges (full domain — non-monotonic V is fine).
      let vMin = Infinity, vMax = -Infinity;
      for (const v of V) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
      let pMin = Infinity, pMax = -Infinity;
      for (const p of P) { if (p < pMin) pMin = p; if (p > pMax) pMax = p; }
      // Sanity guards.
      if (!isFinite(vMin) || !isFinite(vMax) || !isFinite(pMin) || !isFinite(pMax)) {
        ctx.fillStyle = LABEL_COLOR;
        ctx.fillText("(non-finite data)", 8, 20);
        return;
      }
      // Pad ranges by 5% for breathing room.
      const vPad = (vMax - vMin) * 0.05 || 1;
      const pPad = (pMax - pMin) * 0.05 || 1;
      let vLo = vMin - vPad, vHi = vMax + vPad;
      let pLo = logP ? Math.max(pMin * 0.7, 1e-3) : Math.min(pMin - pPad, 0);
      let pHi = logP ? pMax * 1.4 : pMax + pPad;

      // Plot area (leave room for axes/labels).
      const padLeft = 52, padRight = 14, padTop = 8, padBottom = 32;
      const plotW = Math.max(cssW - padLeft - padRight, 10);
      const plotH = Math.max(cssH - padTop - padBottom, 10);
      const x0 = padLeft, y0 = padTop;

      // Coord helpers.
      const xOf = (v: number) =>
        x0 + ((v - vLo) / (vHi - vLo)) * plotW;
      const yOf = (p: number) => {
        const t = logP
          ? (Math.log(Math.max(p, 1e-9)) - Math.log(pLo)) /
            (Math.log(pHi) - Math.log(pLo))
          : (p - pLo) / (pHi - pLo);
        return y0 + (1 - t) * plotH;
      };

      // --- Grid + axes ---
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = TICK_COLOR;

      // X ticks (6 evenly spaced)
      for (let i = 0; i <= 6; i++) {
        const v = vLo + (i / 6) * (vHi - vLo);
        const x = xOf(v);
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + plotH); ctx.stroke();
        ctx.fillText(v.toFixed(v < 1000 ? 1 : 0), x - 12, y0 + plotH + 14);
      }
      // Y ticks (5)
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        const p = logP
          ? Math.exp(Math.log(pLo) + t * (Math.log(pHi) - Math.log(pLo)))
          : pLo + t * (pHi - pLo);
        const y = yOf(p);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
        ctx.fillText(p.toFixed(p < 10 ? 2 : p < 100 ? 1 : 0), 8, y + 3);
      }
      // Axis box
      ctx.strokeStyle = AXIS_COLOR;
      ctx.strokeRect(x0, y0, plotW, plotH);

      // X / Y axis labels
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(`V (${vUnits})`, x0 + plotW / 2 - 20, y0 + plotH + 26);
      ctx.save();
      ctx.translate(14, y0 + plotH / 2 + 30);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`P (${pUnits})${logP ? " — log" : ""}`, 0, 0);
      ctx.restore();

      // --- Loop trace ---
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < V.length; i++) {
        const v = V[i] as number;
        const p = P[i] as number;
        if (!isFinite(v) || !isFinite(p)) {
          started = false;
          continue;
        }
        const x = xOf(v);
        const y = yOf(p);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    draw();

    // Resize observer for responsive canvas
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [V, P, vUnits, pUnits, logP, color, height]);

  // Repaint on data updates (useEffect for completeness — the layout
  // effect above already covers all deps).
  useEffect(() => { /* render handled by useLayoutEffect */ }, [V, P]);

  return (
    <div ref={wrapRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
        <span className="flex items-center gap-1 text-[10px] text-[#5A5F66]">
          <span className="inline-block h-[2px] w-3" style={{ background: color }} />
          P-V
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
