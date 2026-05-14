import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface EngineBarConfig {
  rpmChannelId: string;
  gearChannelId?: string;
  redline: number;
  shiftLightStart: number;
  segments: number;
}

export function EngineBarRender(props: WidgetRenderProps<EngineBarConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rpmRef = useRef<number | null>(sampleAt(slice, config.rpmChannelId, cursorEmitter.get()));
  const peakRef = useRef<number | null>(rpmRef.current);
  const gearRef = useRef<number | null>(config.gearChannelId ? sampleAt(slice, config.gearChannelId, cursorEmitter.get()) : null);
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = draw;  // updated every render so async callbacks see the latest closure

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const r = sampleAt(slice, config.rpmChannelId, t);
      rpmRef.current = r;
      if (r !== null && (peakRef.current === null || r > peakRef.current)) peakRef.current = r;
      gearRef.current = config.gearChannelId ? sampleAt(slice, config.gearChannelId, t) : null;
      drawRef.current();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  // Reset peak RPM whenever the viewing window or RPM channel changes.
  // Otherwise the peak ratchets upward forever — switching primary session
  // or scrubbing into a slower lap leaves the user staring at an unreachable
  // peak marker from data they're no longer looking at.
  useEffect(() => {
    const r = sampleAt(slice, config.rpmChannelId, cursorEmitter.get());
    rpmRef.current = r;
    peakRef.current = r;
    drawRef.current();
  }, [slice.range.startUs, slice.range.endUs, config.rpmChannelId, cursorEmitter, slice, config]);

  const onResize = useCallback(() => { drawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const gearW = h * 0.9;
    const barX = gearW + 8, barY = 4;
    const barW = w - barX - 4, barH = h - 8;

    ctx.fillStyle = "#0E0E10";
    ctx.fillRect(0, 0, gearW, h);
    ctx.strokeStyle = "#2A2C32";
    ctx.strokeRect(0.5, 0.5, gearW - 1, h - 1);
    ctx.fillStyle = "#FFC627";
    ctx.font = `bold ${Math.floor(h * 0.6)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const g = gearRef.current;
    ctx.fillText(g === null ? "—" : (g === 0 ? "N" : String(Math.round(g))), gearW / 2, h / 2);

    const r = rpmRef.current ?? 0;
    const t = Math.max(0, Math.min(1, r / config.redline));
    const segs = config.segments;
    const segGap = 2;
    const segW = (barW - segGap * (segs - 1)) / segs;
    for (let i = 0; i < segs; i++) {
      const segT = (i + 1) / segs;
      const lit = segT <= t;
      const inShift = (i / segs) >= (config.shiftLightStart / config.redline);
      ctx.fillStyle = lit
        ? (inShift ? (segT > 0.95 ? "#EF5350" : "#FFB800") : "#4FC3F7")
        : "#23252B";
      ctx.fillRect(barX + i * (segW + segGap), barY, segW, barH);
    }

    if (peakRef.current !== null) {
      const pt = Math.max(0, Math.min(1, peakRef.current / config.redline));
      const px = barX + barW * pt;
      ctx.strokeStyle = "#D8DCE2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, barY - 2); ctx.lineTo(px, barY + barH + 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#D8DCE2";
    ctx.font = `bold ${Math.floor(h * 0.5)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(r === 0 ? "—" : String(Math.round(r)), barX + barW - 8, h / 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
