import { useCallback, useEffect, useRef } from "react";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface HistogramConfig {
  channelId: string;
  bins: number;
  min?: number;
  max?: number;
  color: string;
}

export function HistogramRender(props: WidgetRenderProps<HistogramConfig>) {
  const { config, slice, cursorEmitter: _c, timeRange, overlays } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: config.color, slice, range: timeRange, isPrimary: true }];

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { draw(); }, [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  const onResize = useCallback(() => { draw(); }, []);
  useResizeObserver(canvasRef, onResize);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    // Collect every visible session that carries the configured channel.
    const datasets: { session: OverlaySession; data: Float64Array }[] = [];
    for (const session of visible) {
      const data = session.slice.data.get(config.channelId);
      if (data && data.length > 0) datasets.push({ session, data });
    }
    if (datasets.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }

    // Bin range: explicit config wins, otherwise the union of all visible
    // sessions' values so bins stay aligned across overlays.
    let lo = config.min, hi = config.max;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity, mx = -Infinity;
      for (const d of datasets) {
        for (let i = 0; i < d.data.length; i++) {
          const v = d.data[i]!;
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
      }
      lo = lo ?? mn; hi = hi ?? mx;
    }
    const bins = Math.max(1, Math.min(200, config.bins));
    const span = Math.max(1e-9, hi! - lo!);

    // Bin every dataset; track the global max so all sessions share a Y axis.
    const counts: Uint32Array[] = datasets.map(() => new Uint32Array(bins));
    let maxCount = 0;
    for (let di = 0; di < datasets.length; di++) {
      const d = datasets[di]!.data;
      const c = counts[di]!;
      for (let i = 0; i < d.length; i++) {
        const idx = Math.max(0, Math.min(bins - 1, Math.floor(((d[i]! - lo!) / span) * bins)));
        c[idx]!++;
      }
      for (let i = 0; i < bins; i++) if (c[i]! > maxCount) maxCount = c[i]!;
    }

    const padL = 4, padR = 4, padT = 18, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const binW = plotW / bins;

    const isMulti = datasets.length > 1;

    if (!isMulti) {
      // Single session: keep the v1 filled-bar look.
      const counts0 = counts[0]!;
      ctx.fillStyle = datasets[0]!.session.color;
      for (let i = 0; i < bins; i++) {
        const barH = maxCount === 0 ? 0 : (counts0[i]! / maxCount) * plotH;
        ctx.fillRect(padL + i * binW + 0.5, padT + plotH - barH, Math.max(1, binW - 1), barH);
      }
    } else {
      // Multi-session: stepped outlines per session so all distributions are
      // visible at once. Light fill (~20% alpha) layered behind for context.
      for (let di = 0; di < datasets.length; di++) {
        const ds = datasets[di]!;
        const c = counts[di]!;
        ctx.lineWidth = ds.session.isPrimary ? 2 : 1.5;
        ctx.strokeStyle = ds.session.color;
        ctx.fillStyle = withAlpha(ds.session.color, 0.18);

        ctx.beginPath();
        const y0 = padT + plotH;
        ctx.moveTo(padL, y0);
        for (let i = 0; i < bins; i++) {
          const barH = maxCount === 0 ? 0 : (c[i]! / maxCount) * plotH;
          const x0 = padL + i * binW;
          const x1 = padL + (i + 1) * binW;
          const yTop = padT + plotH - barH;
          ctx.lineTo(x0, yTop);
          ctx.lineTo(x1, yTop);
        }
        ctx.lineTo(padL + plotW, y0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const totalN = datasets.reduce((s, d) => s + d.data.length, 0);
    ctx.fillText(
      `${config.channelId} · ${datasets.length} session${datasets.length === 1 ? "" : "s"} · n=${totalN}`,
      4, 4,
    );
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(lo!.toFixed(1), padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(hi!.toFixed(1), w - padR, h - 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}

/** Convert a #RRGGBB hex color into rgba() with the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
