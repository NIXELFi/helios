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
  /** When set, draw a vertical split marker and per-side stats (e.g. shock-pot rebound vs compression). Bin edges are realigned so one falls exactly on this value. */
  splitAt?: number;
  /** When true (and splitAt is set), mirror the range around splitAt so each side gets equal width and bin count — useful for comparing rebound vs compression directly. */
  splitSymmetric?: boolean;
}

export function HistogramRender(props: WidgetRenderProps<HistogramConfig>) {
  const { config, slice, cursorEmitter: _c, timeRange, overlays, viewState } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = draw;  // updated every render so async callbacks see the latest closure

  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: config.color, slice, range: timeRange, isPrimary: true }];

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { drawRef.current(); }, [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  // Re-bin whenever the global zoom range changes (drag-zoom on a strip
  // chart, double-click reset, etc.). Read via ref so we don't have to
  // marshal the zoom into React state.
  useEffect(() => {
    if (!viewState) return;
    return viewState.subscribe(() => drawRef.current());
  }, [viewState]);

  const onResize = useCallback(() => { drawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    // Collect every visible session that carries the configured channel.
    // When a global zoom is active, narrow each dataset to the index range
    // that falls within the zoom window. The slice's `time` array is parallel
    // to its `data`, so a binary search on time gives the bin loop bounds.
    const zoom = viewState?.get().zoomRange ?? null;
    const datasets: { session: OverlaySession; data: Float64Array; iStart: number; iEnd: number }[] = [];
    for (const session of visible) {
      const data = session.slice.data.get(config.channelId);
      if (!data || data.length === 0) continue;
      let iStart = 0, iEnd = data.length;
      if (zoom) {
        const t = session.slice.time;
        iStart = lowerBoundUs(t, zoom.startUs);
        iEnd = lowerBoundUs(t, zoom.endUs);
      }
      if (iEnd > iStart) datasets.push({ session, data, iStart, iEnd });
    }
    if (datasets.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }

    // Bin range: explicit config wins, otherwise the union of all visible
    // sessions' values (within zoom) so bins stay aligned across overlays.
    let lo = config.min, hi = config.max;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity, mx = -Infinity;
      for (const d of datasets) {
        for (let i = d.iStart; i < d.iEnd; i++) {
          const v = d.data[i]!;
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
      }
      lo = lo ?? mn; hi = hi ?? mx;
    }
    const bins = Math.max(1, Math.min(200, config.bins));

    // Optional split: realign bin edges so one falls exactly on splitAt.
    // Bins are partitioned into a negative segment [lo, splitAt] and a
    // positive segment [splitAt, hi], each with their own uniform grid.
    const splitAt = config.splitAt;
    const splitOn = splitAt !== undefined && splitAt > lo! && splitAt < hi!;

    // Symmetric mode: mirror the range around splitAt so each side has equal
    // width and gets the same number of bins. The shorter side renders empty
    // space at the outer edge, which itself signals data asymmetry.
    if (splitOn && config.splitSymmetric) {
      const half = Math.max(splitAt! - lo!, hi! - splitAt!);
      lo = splitAt! - half;
      hi = splitAt! + half;
    }
    const span = Math.max(1e-9, hi! - lo!);
    let nNeg = 0, nPos = bins;
    let negSpan = 0, posSpan = span;
    if (splitOn) {
      nNeg = Math.max(1, Math.min(bins - 1, Math.round(bins * (splitAt! - lo!) / span)));
      nPos = bins - nNeg;
      negSpan = Math.max(1e-9, splitAt! - lo!);
      posSpan = Math.max(1e-9, hi! - splitAt!);
    }

    // Bin every dataset; track the global max so all sessions share a Y axis.
    // Also accumulate per-side stats from raw values (not bins) when split is on.
    const counts: Uint32Array[] = datasets.map(() => new Uint32Array(bins));
    const sideStats: { negN: number; posN: number; negSum: number; posSum: number }[] = datasets.map(() => ({ negN: 0, posN: 0, negSum: 0, posSum: 0 }));
    let maxCount = 0;
    for (let di = 0; di < datasets.length; di++) {
      const ds = datasets[di]!;
      const d = ds.data;
      const c = counts[di]!;
      const s = sideStats[di]!;
      for (let i = ds.iStart; i < ds.iEnd; i++) {
        const v = d[i]!;
        let idx: number;
        if (splitOn) {
          if (v < splitAt!) {
            idx = Math.max(0, Math.min(nNeg - 1, Math.floor(((v - lo!) / negSpan) * nNeg)));
            s.negN++; s.negSum += v;
          } else {
            idx = Math.max(nNeg, Math.min(bins - 1, nNeg + Math.floor(((v - splitAt!) / posSpan) * nPos)));
            s.posN++; s.posSum += v;
          }
        } else {
          idx = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo!) / span) * bins)));
        }
        c[idx]!++;
      }
      for (let i = 0; i < bins; i++) if (c[i]! > maxCount) maxCount = c[i]!;
    }

    const padL = 28, padR = 4, padT = 18, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    // Y-axis grid + labels. 4 evenly-spaced tick lines including the top.
    // Counts above 1000 collapse to "1.2k"-style; sub-1000 are integers.
    // The grid sits behind the bars so we draw it first, before any fill.
    if (maxCount > 0 && plotH > 30) {
      ctx.save();
      ctx.strokeStyle = "#23252B";
      ctx.lineWidth = 1;
      ctx.fillStyle = "#5A5F66";
      ctx.font = "9px Inter, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const frac = i / ticks;
        const y = padT + plotH * (1 - frac);
        const value = Math.round(maxCount * frac);
        if (i > 0) {
          ctx.beginPath();
          ctx.moveTo(padL, y + 0.5);
          ctx.lineTo(padL + plotW, y + 0.5);
          ctx.stroke();
        }
        const label = value >= 10000 ? `${(value / 1000).toFixed(0)}k`
          : value >= 1000 ? `${(value / 1000).toFixed(1)}k`
          : `${value}`;
        ctx.fillText(label, padL - 3, y);
      }
      ctx.restore();
    }
    const splitX = splitOn ? padL + plotW * (negSpan / span) : padL;
    const binWNeg = splitOn && nNeg > 0 ? (splitX - padL) / nNeg : plotW / bins;
    const binWPos = splitOn && nPos > 0 ? (padL + plotW - splitX) / nPos : plotW / bins;
    const binW = plotW / bins; // legacy uniform width when split is off

    // Maps a bin index to its [x0, x1] in canvas coords, using split-aware grids.
    const binBounds = (i: number): [number, number] => {
      if (!splitOn) return [padL + i * binW, padL + (i + 1) * binW];
      if (i < nNeg) return [padL + i * binWNeg, padL + (i + 1) * binWNeg];
      const k = i - nNeg;
      return [splitX + k * binWPos, splitX + (k + 1) * binWPos];
    };

    const isMulti = datasets.length > 1;

    if (!isMulti) {
      // Single session: keep the v1 filled-bar look. Use the configured
      // color (editable in the config panel), not the session palette color
      // — otherwise edits to `color` in the config editor would have no
      // visible effect when only one session is visible.
      const counts0 = counts[0]!;
      ctx.fillStyle = config.color;
      for (let i = 0; i < bins; i++) {
        const [x0, x1] = binBounds(i);
        const barH = maxCount === 0 ? 0 : (counts0[i]! / maxCount) * plotH;
        ctx.fillRect(x0 + 0.5, padT + plotH - barH, Math.max(1, x1 - x0 - 1), barH);
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
          const [x0, x1] = binBounds(i);
          const barH = maxCount === 0 ? 0 : (c[i]! / maxCount) * plotH;
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

    // Split marker: dashed vertical line at the split position, with the
    // numeric value just above the baseline so it's clear what's being split.
    if (splitOn) {
      ctx.save();
      ctx.strokeStyle = "#9AA0A6";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(splitX + 0.5, padT);
      ctx.lineTo(splitX + 0.5, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const totalN = datasets.reduce((s, d) => s + (d.iEnd - d.iStart), 0);
    ctx.fillText(
      `${config.channelId} · ${datasets.length} session${datasets.length === 1 ? "" : "s"} · n=${totalN}`,
      4, 4,
    );
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(lo!.toFixed(1), padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(hi!.toFixed(1), w - padR, h - 2);

    // Per-side stats: shown above the bars on each side of the split line.
    // Single-session uses the configured color; multi-session uses each
    // session's palette color and stacks one short row per session.
    if (splitOn) {
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#9AA0A6";
      ctx.textAlign = "center";
      ctx.fillText(splitAt!.toFixed(1), splitX, h - 2);

      const fmt = (n: number, mean: number) => `n=${n}${n > 0 ? ` μ=${mean.toFixed(1)}` : ""}`;
      ctx.textBaseline = "top";
      const rowH = 11;
      for (let di = 0; di < datasets.length; di++) {
        const s = sideStats[di]!;
        const negMean = s.negN > 0 ? s.negSum / s.negN : 0;
        const posMean = s.posN > 0 ? s.posSum / s.posN : 0;
        ctx.fillStyle = isMulti ? datasets[di]!.session.color : config.color;
        const y = padT + 2 + di * rowH;
        ctx.textAlign = "right";
        ctx.fillText(fmt(s.negN, negMean), splitX - 4, y);
        ctx.textAlign = "left";
        ctx.fillText(fmt(s.posN, posMean), splitX + 4, y);
      }
    }
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}

/** Convert a #RRGGBB hex color into rgba() with the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** First index `i` in a non-decreasing BigInt64 time array (microseconds)
 *  such that time[i] >= targetUs. Returns time.length if every entry is
 *  smaller. Used to clamp the histogram's bin loop to a zoomed time window. */
function lowerBoundUs(time: BigInt64Array, targetUs: number): number {
  let lo = 0, hi = time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(time[mid]!) < targetUs) lo = mid + 1; else hi = mid;
  }
  return lo;
}
