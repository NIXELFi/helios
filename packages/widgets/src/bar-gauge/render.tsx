import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize, thresholdColor } from "../lib/canvas-helpers";

export interface BarGaugeConfig {
  channelId: string;
  units: string;
  decimals: number;
  min: number;
  max: number;
  warn?: number;
  alarm?: number;
  orientation: "vertical" | "horizontal";
}

export function BarGaugeRender(props: WidgetRenderProps<BarGaugeConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));
  const peakRef = useRef<number | null>(valueRef.current);

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const v = sampleAt(slice, config.channelId, t);
      valueRef.current = v;
      if (v !== null && (peakRef.current === null || v > peakRef.current)) peakRef.current = v;
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => { peakRef.current = valueRef.current; draw(); }, [config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    const horiz = config.orientation === "horizontal";
    ctx.clearRect(0, 0, w, h);

    const padX = 28, padY = 28;
    const trackX = padX, trackY = padY;
    const trackW = w - padX * 2, trackH = h - padY * 2;
    const v = valueRef.current;
    const span = config.max - config.min;
    const t = v === null ? 0 : Math.max(0, Math.min(1, (v - config.min) / span));

    ctx.fillStyle = "#0E0E10";
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.strokeStyle = "#2A2C32";
    ctx.strokeRect(trackX, trackY, trackW, trackH);

    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    if (horiz) ctx.fillRect(trackX, trackY, trackW * t, trackH);
    else       ctx.fillRect(trackX, trackY + trackH * (1 - t), trackW, trackH * t);

    ctx.strokeStyle = "#FFB800";
    if (config.warn !== undefined) {
      const wt = (config.warn - config.min) / span;
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, wt);
    }
    ctx.strokeStyle = "#EF5350";
    if (config.alarm !== undefined) {
      const at = (config.alarm - config.min) / span;
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, at);
    }

    if (peakRef.current !== null) {
      const pt = Math.max(0, Math.min(1, (peakRef.current - config.min) / span));
      ctx.strokeStyle = "#D8DCE2";
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, pt);
    }

    ctx.fillStyle = "#7B8088";
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(config.channelId, 4, 4);
    ctx.textAlign = "right";
    ctx.fillText(config.units, w - 4, 4);

    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    ctx.font = '14px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(v === null ? "—" : v.toFixed(config.decimals), w / 2, h - 4);
  }

  function drawTick(ctx: CanvasRenderingContext2D, horiz: boolean, x: number, y: number, w: number, h: number, t: number) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (horiz) {
      const px = x + w * t;
      ctx.moveTo(px, y - 2); ctx.lineTo(px, y + h + 2);
    } else {
      const py = y + h * (1 - t);
      ctx.moveTo(x - 2, py); ctx.lineTo(x + w + 2, py);
    }
    ctx.stroke();
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
