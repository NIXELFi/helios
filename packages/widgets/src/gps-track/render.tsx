import { useCallback, useEffect, useRef } from "react";
import type { ChannelSlice } from "@helios/store";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface GpsTrackConfig {
  latChannelId: string;
  lonChannelId: string;
  /** Track line color in single-session mode. Ignored when more than one
   *  session is visible (each session uses its own palette color) or when
   *  colorByChannelId is set (gradient takes over). */
  color?: string;
  /** optional: color the track by this channel's value (single-session only) */
  colorByChannelId?: string;
  /** when colorBy is set: gradient stops min..max */
  colorMin?: number;
  colorMax?: number;
}

interface SessionProjection {
  session: OverlaySession;
  xs: Float64Array;
  ys: Float64Array;
  n: number;
}

export function GpsTrackRender(props: WidgetRenderProps<GpsTrackConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef<number>(cursorEmitter.get());
  const projsRef = useRef<SessionProjection[]>([]);
  // Indirection ref so long-lived callbacks (cursor subscription, resize
  // observer) always invoke the LATEST `draw` closure rather than a stale
  // one captured at subscription time. Without this, edits to `config`
  // would re-run the dep'd effect to draw with new colors but a subsequent
  // resize/cursor callback would repaint with the old closure's config.
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = draw;  // assigned every render so subscribers always invoke the latest closure

  // Synthesize a single-overlay fallback for callers that haven't passed `overlays`.
  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#4FC3F7", slice, range: timeRange, isPrimary: true }];

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      tRef.current = t;
      drawRef.current();
    });
    return off;
  }, [cursorEmitter]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { drawRef.current(); }, [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  const onResize = useCallback(() => { drawRef.current(); }, []);
  useResizeObserver(canvasRef, onResize);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const projs = projsRef.current; if (projs.length === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = rect.width, h = rect.height;
      const pad = 16;
      // Search across every visible session; click jumps to closest sample anywhere.
      let bestSession: SessionProjection | null = null;
      let bestIdx = 0, bestD = Infinity;
      for (const p of projs) {
        for (let i = 0; i < p.n; i++) {
          const dx = (pad + p.xs[i]! * (w - pad * 2)) - mx;
          const dy = (pad + p.ys[i]! * (h - pad * 2)) - my;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestIdx = i; bestSession = p; }
        }
      }
      if (!bestSession) return;
      const tUs = Number(bestSession.session.slice.time[bestIdx] ?? 0n);
      cursorEmitter.emit(tUs);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      c.setPointerCapture(e.pointerId);
      emitFromEvent(e);
    };
    const onMove = (e: PointerEvent) => { if (dragging) emitFromEvent(e); };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
    };
  }, [cursorEmitter]);

  /** Project every visible session into a shared [0,1]² space using the union
   *  of all sessions' lat/lon bounds. Sessions that lack the channels — or
   *  whose values are all clamped near (0,0) (no GPS fix; e.g. exports where
   *  the receiver wasn't locked) — are skipped so they don't pollute the
   *  shared bbox and collapse a valid track to a single pixel. */
  function projectAll(): SessionProjection[] {
    type RawSession = {
      session: OverlaySession;
      lat: Float64Array;
      lon: Float64Array;
      n: number;
      minLat: number; maxLat: number; minLon: number; maxLon: number;
    };
    const raws: RawSession[] = [];
    for (const session of visible) {
      const s: ChannelSlice = session.slice;
      const lat = s.data.get(config.latChannelId);
      const lon = s.data.get(config.lonChannelId);
      if (!lat || !lon) continue;
      const n = Math.min(lat.length, lon.length);
      if (n === 0) continue;
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (let i = 0; i < n; i++) {
        const la = lat[i]!, lo = lon[i]!;
        if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      }
      // Null-island guard: real driving never lands every sample inside the
      // 1°×1° box around (0,0). MoTeC exports with no GPS fix typically clamp
      // every row to 0, which would otherwise dominate the union bbox.
      const nullIsland = Math.abs(minLat) < 1 && Math.abs(maxLat) < 1
                      && Math.abs(minLon) < 1 && Math.abs(maxLon) < 1;
      if (nullIsland) continue;
      raws.push({ session, lat, lon, n, minLat, maxLat, minLon, maxLon });
    }
    if (raws.length === 0) return [];

    // Union bbox over the surviving sessions.
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const r of raws) {
      if (r.minLat < minLat) minLat = r.minLat;
      if (r.maxLat > maxLat) maxLat = r.maxLat;
      if (r.minLon < minLon) minLon = r.minLon;
      if (r.maxLon > maxLon) maxLon = r.maxLon;
    }
    const latSpan = Math.max(1e-12, maxLat - minLat);
    const lonSpan = Math.max(1e-12, maxLon - minLon);
    return raws.map(({ session, lat, lon, n }) => {
      const xs = new Float64Array(n), ys = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = (lon[i]! - minLon) / lonSpan;
        ys[i] = 1 - (lat[i]! - minLat) / latSpan;
      }
      return { session, xs, ys, n };
    });
  }

  function findIndexForTime(s: ChannelSlice, tUs: number, n: number): number {
    const t = BigInt(Math.round(tUs));
    let lo = 0, hi = s.time.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (s.time[mid]! <= t) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, Math.min(n - 1, lo - 1));
  }

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const projs = projectAll();
    projsRef.current = projs;

    if (projs.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no GPS data", w / 2, h / 2);
      return;
    }

    const pad = 16;
    const isMulti = visible.length > 1;
    const colorByEnabled = !isMulti && config.colorByChannelId
      && config.colorMin !== undefined && config.colorMax !== undefined;

    for (const p of projs) {
      const { xs, ys, n } = p;
      const px = (i: number) => pad + xs[i]! * (w - pad * 2);
      const py = (i: number) => pad + ys[i]! * (h - pad * 2);

      if (colorByEnabled) {
        // Single-session "color by channel" gradient mode preserved from v1.
        const colorBy = p.session.slice.data.get(config.colorByChannelId!);
        const span = config.colorMax! - config.colorMin!;
        ctx.lineWidth = 2.5;
        for (let i = 1; i < n; i++) {
          const t = Math.max(0, Math.min(1, ((colorBy?.[i] ?? 0) - config.colorMin!) / span));
          ctx.strokeStyle = lerpColor("#26A69A", "#FFB800", t);
          ctx.beginPath();
          ctx.moveTo(px(i - 1), py(i - 1));
          ctx.lineTo(px(i), py(i));
          ctx.stroke();
        }
      } else {
        // Solid line. In single-session mode, prefer the user-configured
        // color so edits in the config panel are visible; fall back to the
        // session palette color when nothing is configured or when multiple
        // sessions are overlaid.
        ctx.strokeStyle = !isMulti && config.color ? config.color : p.session.color;
        ctx.lineWidth = p.session.isPrimary ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(px(0), py(0));
        for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(i));
        ctx.stroke();
      }

      // Cursor dot for this session at the current time. Match the line
      // color so the dot reads as part of the same trace.
      const idx = findIndexForTime(p.session.slice, tRef.current, n);
      const cx = px(idx), cy = py(idx);
      ctx.fillStyle = !isMulti && config.color ? config.color : p.session.color;
      ctx.beginPath();
      ctx.arc(cx, cy, p.session.isPrimary ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const totalPts = projs.reduce((s, p) => s + p.n, 0);
    ctx.fillText(
      `GPS · ${projs.length} session${projs.length === 1 ? "" : "s"} · ${totalPts} pts`,
      6, 6,
    );
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B] cursor-crosshair" />;
}

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = hex2(aHex), b = hex2(bHex);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex2(h: string) {
  const v = parseInt(h.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}
