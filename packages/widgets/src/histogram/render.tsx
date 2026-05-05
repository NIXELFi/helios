import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface HistogramConfig {
  channelId: string;
  bins: number;
  min?: number;
  max?: number;
  color: string;
}

export function HistogramRender(props: WidgetRenderProps<HistogramConfig>) {
  const { config, slice } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { draw(); }, [slice, config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const data = slice.data.get(config.channelId);
    if (!data || data.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }

    let lo = config.min, hi = config.max;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]!;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      lo = lo ?? mn; hi = hi ?? mx;
    }
    const bins = Math.max(1, Math.min(200, config.bins));
    const counts = new Uint32Array(bins);
    const span = Math.max(1e-9, hi - lo);
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      const idx = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / span) * bins)));
      counts[idx]!++;
    }
    let maxCount = 0;
    for (let i = 0; i < bins; i++) if (counts[i]! > maxCount) maxCount = counts[i]!;

    const padL = 4, padR = 4, padT = 18, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const binW = plotW / bins;

    ctx.fillStyle = config.color;
    for (let i = 0; i < bins; i++) {
      const barH = maxCount === 0 ? 0 : (counts[i]! / maxCount) * plotH;
      ctx.fillRect(padL + i * binW + 0.5, padT + plotH - barH, Math.max(1, binW - 1), barH);
    }

    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${config.channelId} · n=${data.length}`, 4, 4);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(lo!.toFixed(1), padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(hi!.toFixed(1), w - padR, h - 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
