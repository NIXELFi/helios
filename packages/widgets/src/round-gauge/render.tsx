import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize, thresholdColor } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface RoundGaugeConfig {
  channelId: string;
  units: string;
  decimals: number;
  min: number;
  max: number;
  warn?: number;
  alarm?: number;
  /** sweep angle in radians — default 270° */
  sweep?: number;
}

export function RoundGaugeRender(props: WidgetRenderProps<RoundGaugeConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      valueRef.current = sampleAt(slice, config.channelId, t);
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => {
    draw();
  }, [config]);

  const onResize = useCallback(() => { draw(); }, []);
  useResizeObserver(canvasRef, onResize);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    const cx = w / 2, cy = h * 0.6;
    const r = Math.min(w, h) * 0.42;
    const sweep = config.sweep ?? Math.PI * 1.5;
    const start = Math.PI / 2 + (Math.PI * 2 - sweep) / 2 + Math.PI;
    const end = start + sweep;

    ctx.clearRect(0, 0, w, h);

    ctx.lineWidth = 8;
    ctx.strokeStyle = "#23252B";
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();

    const span = config.max - config.min;
    if (config.warn !== undefined) {
      const warnT = (config.warn - config.min) / span;
      ctx.strokeStyle = "#FFB800";
      ctx.beginPath();
      ctx.arc(cx, cy, r, start + warnT * sweep, start + (config.alarm !== undefined ? (config.alarm - config.min) / span : 1) * sweep);
      ctx.stroke();
    }
    if (config.alarm !== undefined) {
      const alarmT = (config.alarm - config.min) / span;
      ctx.strokeStyle = "#EF5350";
      ctx.beginPath();
      ctx.arc(cx, cy, r, start + alarmT * sweep, end);
      ctx.stroke();
    }

    ctx.strokeStyle = "#5A5F66";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const a = start + (i / 10) * sweep;
      const r1 = r + 4, r2 = r + 10;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    const v = valueRef.current;
    if (v !== null) {
      const t = Math.max(0, Math.min(1, (v - config.min) / span));
      const a = start + t * sweep;
      ctx.strokeStyle = thresholdColor(v, config.warn, config.alarm);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
      ctx.stroke();
      ctx.fillStyle = "#D8DCE2";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    ctx.font = `${Math.max(14, r * 0.35)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = v === null ? "—" : v.toFixed(config.decimals);
    ctx.fillText(text, cx, cy + r * 0.45);

    ctx.fillStyle = "#7B8088";
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillText(config.channelId.toUpperCase(), cx, 14);
    ctx.fillText(config.units, cx, cy + r * 0.85);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
