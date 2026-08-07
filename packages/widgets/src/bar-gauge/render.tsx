import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize, thresholdColor } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface BarGaugeConfig {
  channelId: string;
  units: string;
  decimals: number;
  min: number;
  max: number;
  warn?: number;
  alarm?: number;
  /** Low-side bounds, for channels that alarm on the way down (oil pressure,
   *  fuel pressure, battery voltage). Independent of the high-side pair. */
  warnLow?: number;
  alarmLow?: number;
  orientation: "vertical" | "horizontal";
}

export function BarGaugeRender(props: WidgetRenderProps<BarGaugeConfig>) {
  const { config, slice, cursorEmitter, overlays } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));
  const peakRef = useRef<number | null>(valueRef.current);
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = draw;  // updated every render so async callbacks see the latest closure

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const v = sampleAt(slice, config.channelId, t);
      valueRef.current = v;
      if (v !== null && Number.isFinite(v) && (peakRef.current === null || v > peakRef.current)) peakRef.current = v;
      drawRef.current();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  // Reset peak-hold whenever the viewing window, channel, or primary session
  // changes — that's the natural "different context, start a new peak"
  // signal. Without this, peak only ever moves up across the entire app
  // lifetime: scrubbing back to a slower section, switching primary session,
  // or applying a zoom all leave the peak marker stuck at a value the user
  // can't currently see.
  //
  // The key is built from values only. `slice` and `config` are rebuilt by
  // the Tile host on every React render, so their object identity churns
  // constantly and must never be a reset trigger: keying on it wiped the peak
  // on any unrelated UI churn (a lap click, a panel toggle), which defeated
  // peak-hold entirely. The scale (min/max) is deliberately absent — it moves
  // where the marker is drawn, not whether the observed peak is still true.
  const peakKey = [
    overlays?.[0]?.id ?? "",  // overlays[0] is the primary session (see types.ts)
    config.channelId,
    slice.range.startUs,
    slice.range.endUs,
  ].join("\u0000");
  const peakKeyRef = useRef<string | null>(null);

  // No dep array: the redraw must still happen on every render (config edits
  // change the scale, units and decimals), but the peak reset is gated behind
  // the key comparison above.
  useEffect(() => {
    const v = sampleAt(slice, config.channelId, cursorEmitter.get());
    valueRef.current = v;
    if (peakKeyRef.current !== peakKey) {
      peakKeyRef.current = peakKey;
      // NaN would stick permanently: it never compares greater than itself, so
      // a NaN seed can never be replaced by a later real sample.
      peakRef.current = v !== null && Number.isFinite(v) ? v : null;
    }
    drawRef.current();
  });

  const onResize = useCallback(() => { drawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

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
    const color = thresholdColor(v, config.warn, config.alarm, config.warnLow, config.alarmLow);

    ctx.fillStyle = "#0E0E10";
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.strokeStyle = "#2A2C32";
    ctx.strokeRect(trackX, trackY, trackW, trackH);

    ctx.fillStyle = color;
    if (horiz) ctx.fillRect(trackX, trackY, trackW * t, trackH);
    else       ctx.fillRect(trackX, trackY + trackH * (1 - t), trackW, trackH * t);

    // Threshold ticks. Both sides of the scale use the same visual language —
    // amber for warn, red for alarm — so a low-side bound reads identically to
    // a high-side one. Alarms are drawn last so they win where the two
    // coincide.
    for (const [bound, tickColor] of [
      [config.warn, "#FFB800"],
      [config.warnLow, "#FFB800"],
      [config.alarm, "#EF5350"],
      [config.alarmLow, "#EF5350"],
    ] as const) {
      if (bound === undefined) continue;
      ctx.strokeStyle = tickColor;
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, (bound - config.min) / span);
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

    ctx.fillStyle = color;
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
