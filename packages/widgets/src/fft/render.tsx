import { useCallback, useEffect, useMemo, useRef } from "react";
import { magnitudeSpectrum, pow2Floor } from "@helios/lib";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";
import type { WidgetRenderProps, OverlaySession } from "../types";

export interface FftConfig {
  channelId: string;
  /** When true, restrict the FFT to the current zoom window (or to the
   *  current zone if you've placed datums). */
  useZoomRange: boolean;
  /** Apply a Hanning window before transforming. Default true. */
  windowed: boolean;
  /** Vertical scale: 'linear' or 'db' (20·log10). */
  scale: "linear" | "db";
  /** Horizontal scale: 'linear' or 'log'. */
  freqScale: "linear" | "log";
  /** Display upper frequency bound in Hz. Auto when ≤ 0. */
  fmaxHz: number;
}

export function FftRender(props: WidgetRenderProps<FftConfig>) {
  const { config, slice, viewState, overlays, timeRange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];

  const onResize = useCallback(() => { drawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

  // Stabilize the visible sessions identity: only the session ids drive which
  // sessions are in the FFT — the slice objects change identity on every parent
  // render but their data is only different when the id set changes.
  const visibleIdsKey = JSON.stringify(visible.map((v) => v.id));

  const spectra = useMemo(() => {
    const zoom = config.useZoomRange ? viewState?.get().zoomRange ?? null : null;
    const out: { session: OverlaySession; freq: Float64Array; mag: Float64Array; n: number; fs: number }[] = [];
    for (const s of visible) {
      const arr = s.slice.data.get(config.channelId);
      if (!arr || arr.length < 4) continue;
      let iStart = 0, iEnd = arr.length;
      if (zoom) {
        iStart = lowerBoundUs(s.slice.time, zoom.startUs);
        iEnd = lowerBoundUs(s.slice.time, zoom.endUs);
      }
      const n = pow2Floor(iEnd - iStart);
      if (n < 4) continue;
      // Sample rate: from first/last timestamps in the windowed range.
      const t0 = Number(s.slice.time[iStart]!);
      const tN = Number(s.slice.time[iStart + n - 1]!);
      const dur = (tN - t0) / 1_000_000;
      const fs = dur > 0 ? (n - 1) / dur : 0;
      if (fs <= 0) continue;
      const window = arr.subarray(iStart, iStart + n);
      const { freqHz, magnitude } = magnitudeSpectrum(window, fs, config.windowed);
      out.push({ session: s, freq: freqHz, mag: magnitude, n, fs });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, config, viewState]);

  // Subscribe to zoom changes so the windowed FFT recomputes when the user
  // drag-zooms a strip chart.
  useEffect(() => {
    if (!viewState) return;
    return viewState.subscribe(() => drawRef.current());
  }, [viewState]);

  drawRef.current = () => {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    // First-paint guard: if layout hasn't given the canvas a non-zero size
    // yet (ResizeObserver can fire with a 0x0 contentRect on initial
    // observation), schedule a retry on the next animation frame. The
    // ResizeObserver will also fire when real dims arrive, so this is a
    // belt-and-suspenders second chance, not the primary path.
    if (w <= 0 || h <= 0) {
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => drawRef.current());
      }
      return;
    }
    ctx.clearRect(0, 0, w, h);
    if (spectra.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`no data for ${config.channelId}`, w / 2, h / 2);
      return;
    }
    const padL = 36, padR = 8, padT = 16, padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    let fMax = config.fmaxHz > 0 ? config.fmaxHz : 0;
    let mMax = -Infinity, mMin = Infinity;
    for (const s of spectra) {
      if (config.fmaxHz <= 0) {
        const last = s.freq[s.freq.length - 1] ?? 0;
        if (last > fMax) fMax = last;
      }
      for (let i = 0; i < s.mag.length; i++) {
        const v = config.scale === "db"
          ? 20 * Math.log10(Math.max(1e-12, s.mag[i]!))
          : s.mag[i]!;
        if (v > mMax) mMax = v;
        if (v < mMin) mMin = v;
      }
    }
    if (config.scale === "linear") mMin = 0;
    if (!Number.isFinite(mMax) || !Number.isFinite(mMin) || fMax <= 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no spectral content", w / 2, h / 2); return;
    }
    if (mMax === mMin) mMax = mMin + 1;

    const fMinPlot = config.freqScale === "log" ? Math.max(1, spectra[0]!.freq[1] ?? 1) : 0;
    const logSpan = config.freqScale === "log"
      ? Math.log10(fMax) - Math.log10(fMinPlot)
      : 1;
    // Guard against fMax === fMinPlot (degenerate single-bin FFT) which would
    // produce division by zero and NaN x-coordinates for every sample.
    const safeLogSpan = logSpan > 0 ? logSpan : 1;
    const xToCanvas = config.freqScale === "log"
      ? (f: number) => padL + plotW * (Math.log10(Math.max(fMinPlot, f)) - Math.log10(fMinPlot))
                                  / safeLogSpan
      : (f: number) => padL + plotW * (f / fMax);
    const yToCanvas = (v: number) => padT + plotH * (1 - (v - mMin) / (mMax - mMin));

    // Frame
    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW + 0.5, padT + plotH + 0.5);
    ctx.stroke();

    // Plot each session
    for (const s of spectra) {
      ctx.strokeStyle = s.session.color;
      ctx.lineWidth = s.session.isPrimary ? 1.5 : 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.freq.length; i++) {
        const f = s.freq[i]!;
        if (f > fMax) break;
        if (config.freqScale === "log" && f < fMinPlot) continue;
        const v = config.scale === "db"
          ? 20 * Math.log10(Math.max(1e-12, s.mag[i]!))
          : s.mag[i]!;
        const x = xToCanvas(f);
        const y = yToCanvas(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillText(`${config.channelId} · fs ≈ ${spectra[0]!.fs.toFixed(0)} Hz · n=${spectra[0]!.n}`, 4, 4);
    ctx.textBaseline = "bottom"; ctx.textAlign = "left";
    ctx.fillText("0 Hz", padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(`${fMax.toFixed(0)} Hz`, w - padR, h - 2);
    // Y-axis labels
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(`${mMax.toFixed(2)}${config.scale === "db" ? " dB" : ""}`, padL - 3, padT + 5);
    ctx.fillText(`${mMin.toFixed(2)}${config.scale === "db" ? " dB" : ""}`, padL - 3, padT + plotH - 5);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { drawRef.current(); }, [spectra, config]);

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}

function lowerBoundUs(time: BigInt64Array, targetUs: number): number {
  let lo = 0, hi = time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(time[mid]!) < targetUs) lo = mid + 1; else hi = mid;
  }
  return lo;
}
