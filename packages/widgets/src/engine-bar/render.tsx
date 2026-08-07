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
  const { config, slice, cursorEmitter, overlays } = props;
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
      if (r !== null && Number.isFinite(r) && (peakRef.current === null || r > peakRef.current)) peakRef.current = r;
      gearRef.current = config.gearChannelId ? sampleAt(slice, config.gearChannelId, t) : null;
      drawRef.current();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  // Reset peak RPM whenever the viewing window, RPM channel, or primary
  // session changes. Otherwise the peak ratchets upward forever — switching
  // primary session or scrubbing into a slower lap leaves the user staring at
  // an unreachable peak marker from data they're no longer looking at.
  //
  // The key is built from values only. `slice` and `config` are rebuilt by the
  // Tile host on every React render, so their object identity churns
  // constantly and must never be a reset trigger: keying on it wiped the peak
  // on any unrelated UI churn (a lap click, a panel toggle), which defeated
  // peak-hold entirely. `redline` is deliberately absent — it moves where the
  // marker is drawn, not whether the observed peak is still true.
  const peakKey = [
    overlays?.[0]?.id ?? "",  // overlays[0] is the primary session (see types.ts)
    config.rpmChannelId,
    slice.range.startUs,
    slice.range.endUs,
  ].join("\u0000");
  const peakKeyRef = useRef<string | null>(null);

  // No dep array: the redraw must still happen on every render (config edits
  // change the redline and segment count), but the peak reset is gated behind
  // the key comparison above.
  useEffect(() => {
    const r = sampleAt(slice, config.rpmChannelId, cursorEmitter.get());
    rpmRef.current = r;
    if (peakKeyRef.current !== peakKey) {
      peakKeyRef.current = peakKey;
      peakRef.current = r !== null && Number.isFinite(r) ? r : null;
    }
    drawRef.current();
  });

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

    // `sampleAt` returns null only when the channel is missing or the slice is
    // empty, and a non-finite sample is a gap in a channel that is otherwise
    // present — those are the only "no data" cases. A genuine 0 rpm (a stalled
    // engine on track) is real data and must read "0", not "—".
    const sampled = rpmRef.current;
    const rpm = sampled !== null && Number.isFinite(sampled) ? sampled : null;
    const r = rpm ?? 0;  // geometry only: no data draws an unlit bar
    const t = Math.max(0, Math.min(1, r / config.redline));
    const segs = config.segments;
    const segGap = 2;
    const segW = (barW - segGap * (segs - 1)) / segs;
    // Convention: a segment is identified by its far edge, (i+1)/segs. It
    // lights once the needle reaches that edge, and it counts as part of the
    // shift band when that same edge is at or past the band start — so the
    // first shift-coloured segment lights exactly as the needle enters the
    // band. Testing the near edge (i/segs) for band membership instead left
    // the lit set and the shift-coloured set disagreeing by one segment.
    const shiftT = config.shiftLightStart / config.redline;
    for (let i = 0; i < segs; i++) {
      const segT = (i + 1) / segs;
      const lit = segT <= t;
      const inShift = segT >= shiftT;
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
    ctx.fillText(rpm === null ? "—" : String(Math.round(rpm)), barX + barW - 8, h / 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
