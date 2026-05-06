import { useCallback, useEffect, useRef } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ChannelSlice } from "@helios/store";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import { useResizeObserver } from "../lib/use-resize-observer";

export type BasemapMode = "none" | "dark" | "satellite" | "custom";

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
  /** Basemap mode: 'none' = dark canvas with normalized projection (the v2.1
   *  default); 'dark' = CARTO Dark Matter raster tiles; 'satellite' = Esri
   *  World Imagery; 'custom' = caller-supplied tile URL template. */
  basemap?: BasemapMode;
  /** Tile URL template (e.g. https://example.com/{z}/{x}/{y}.png) used when
   *  basemap === 'custom'. Ignored otherwise. */
  customTileUrl?: string;
}

interface SessionRaw {
  session: OverlaySession;
  lat: Float64Array;
  lon: Float64Array;
  n: number;
}

interface NormBbox { minLat: number; maxLat: number; minLon: number; maxLon: number }

const PAD = 16;

function buildStyle(mode: BasemapMode, customTileUrl: string | undefined): StyleSpecification {
  if (mode === "dark") {
    return {
      version: 8,
      sources: {
        base: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
      },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };
  }
  if (mode === "satellite") {
    return {
      version: 8,
      sources: {
        base: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        },
      },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };
  }
  if (mode === "custom" && customTileUrl) {
    return {
      version: 8,
      sources: {
        base: { type: "raster", tiles: [customTileUrl], tileSize: 256 },
      },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };
  }
  // Fallback (shouldn't normally render — mode === 'none' is handled outside).
  return {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#16171B" } }],
  };
}

export function GpsTrackRender(props: WidgetRenderProps<GpsTrackConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const tRef = useRef<number>(cursorEmitter.get());
  const sessionRawsRef = useRef<SessionRaw[]>([]);
  const normBboxRef = useRef<NormBbox | null>(null);
  /** Indirection so long-lived callbacks (cursor sub, resize, map move) always
   *  invoke the LATEST `draw` closure rather than a stale capture. */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = draw;  // assigned every render

  // Synthesize a single-overlay fallback for callers that haven't passed `overlays`.
  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#4FC3F7", slice, range: timeRange, isPrimary: true }];

  const basemap: BasemapMode = config.basemap ?? "none";
  const useMap = basemap !== "none";

  // Cursor subscription
  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      tRef.current = t;
      drawRef.current();
    });
    return off;
  }, [cursorEmitter]);

  // Redraw + (when basemap on) refit when slice/config/overlays change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    fitBoundsToData();
    drawRef.current();
  }, [slice, config, JSON.stringify(visible.map((v) => v.id))]);

  // Resize: maplibre needs an explicit `resize()` and so does our canvas.
  const onResize = useCallback(() => {
    if (mapRef.current) mapRef.current.resize();
    drawRef.current();
  }, []);
  useResizeObserver(containerRef, onResize);

  // Mount/teardown/style-swap of the MapLibre instance based on basemap mode.
  useEffect(() => {
    const div = mapDivRef.current;
    if (!useMap || !div) {
      // Going back to 'none' — tear down if it exists.
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      drawRef.current();
      return;
    }

    if (mapRef.current) {
      mapRef.current.setStyle(buildStyle(basemap, config.customTileUrl));
      mapRef.current.once("styledata", () => {
        mapRef.current?.resize();
        fitBoundsToData();
        drawRef.current();
      });
    } else {
      try {
        // Compute initial bounds up-front so the map opens already framed on
        // the GPS data instead of flashing at zoom 0 / world view. fitBounds
        // after-the-fact races the container's first layout, which left the
        // map showing the whole earth on first paint.
        const { bbox } = buildSessionRaws();
        const initialBounds: [[number, number], [number, number]] | undefined =
          bbox ? [[bbox.minLon, bbox.minLat], [bbox.maxLon, bbox.maxLat]] : undefined;

        const map = new maplibregl.Map({
          container: div,
          style: buildStyle(basemap, config.customTileUrl),
          attributionControl: { compact: true },
          // Read-only basemap: keeps the canvas overlay's click/drag scrub
          // semantics intact across all GPS interactions. fitBounds drives
          // the framing; user does not pan or zoom the basemap directly.
          interactive: false,
          fadeDuration: 0,
          bounds: initialBounds,
          // Tile providers cap out around z18 (CARTO) / z19 (Esri). FSAE
          // tracks are ~90m across, which would push fitBounds to z21+ —
          // beyond any tile source's maxzoom, leaving an empty (dark) map.
          // Cap at z18 so we always have tiles even on the smallest tracks.
          maxZoom: 18,
          fitBoundsOptions: { padding: 24, animate: false, duration: 0, maxZoom: 18 },
        });
        mapRef.current = map;
        map.on("load", () => {
          map.resize();
          fitBoundsToData();
          drawRef.current();
        });
        // Repaint our overlay canvas whenever the map view changes.
        map.on("move", () => drawRef.current());
        map.on("zoom", () => drawRef.current());
        map.on("rotate", () => drawRef.current());
        map.on("pitch", () => drawRef.current());
      } catch (_e) {
        // jsdom / non-DOM test environments don't support MapLibre's WebGL; ignore.
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useMap, basemap, config.customTileUrl]);

  // Final unmount cleanup.
  useEffect(() => () => {
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  }, []);

  // Click/drag scrubbing — operates on the canvas overlay, finds nearest sample
  // across all visible sessions in canvas-pixel space.
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    let dragging = false;
    const emitFromEvent = (e: PointerEvent) => {
      const raws = sessionRawsRef.current; if (raws.length === 0) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = rect.width, h = rect.height;
      let best: { session: OverlaySession; idx: number } | null = null;
      let bestD = Infinity;
      for (const r of raws) {
        for (let i = 0; i < r.n; i++) {
          const pt = projectPoint(r.lat[i]!, r.lon[i]!, w, h);
          const dx = pt.x - mx, dy = pt.y - my;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { session: r.session, idx: i }; }
        }
      }
      if (!best) return;
      const tUs = Number(best.session.slice.time[best.idx] ?? 0n);
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

  /** Compute the union lat/lon bbox over every visible session that has a
   *  real GPS track. Sessions whose values cluster around (0,0) (no GPS fix
   *  in the export) are excluded so they don't poison the bbox. */
  function buildSessionRaws(): { raws: SessionRaw[]; bbox: NormBbox | null } {
    const raws: SessionRaw[] = [];
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const session of visible) {
      const s: ChannelSlice = session.slice;
      const lat = s.data.get(config.latChannelId);
      const lon = s.data.get(config.lonChannelId);
      if (!lat || !lon) continue;
      const n = Math.min(lat.length, lon.length);
      if (n === 0) continue;
      let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
      for (let i = 0; i < n; i++) {
        const la = lat[i]!, lo = lon[i]!;
        if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
        if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo;
      }
      const nullIsland = Math.abs(mnLa) < 1 && Math.abs(mxLa) < 1
                      && Math.abs(mnLo) < 1 && Math.abs(mxLo) < 1;
      if (nullIsland) continue;
      raws.push({ session, lat, lon, n });
      if (mnLa < minLat) minLat = mnLa;
      if (mxLa > maxLat) maxLat = mxLa;
      if (mnLo < minLon) minLon = mnLo;
      if (mxLo > maxLon) maxLon = mxLo;
    }
    if (raws.length === 0) return { raws: [], bbox: null };
    return { raws, bbox: { minLat, maxLat, minLon, maxLon } };
  }

  /** Fit the MapLibre map to the union GPS bbox (if a map is mounted).
   *  Calls resize() first so a container that finished laying out *after*
   *  Map construction (common: map appears via state toggle) gets correct
   *  viewport dimensions before fitBounds calculates the camera. */
  function fitBoundsToData() {
    const map = mapRef.current; if (!map) return;
    const { bbox } = buildSessionRaws();
    if (!bbox) return;
    try {
      map.resize();
      map.fitBounds(
        [[bbox.minLon, bbox.minLat], [bbox.maxLon, bbox.maxLat]],
        { padding: 24, duration: 0, animate: false, maxZoom: 18 },
      );
    } catch (_e) { /* map may not be ready yet */ }
  }

  /** Project a (lat, lon) to canvas-pixel coords. Routes through MapLibre
   *  when a basemap is active, else through the cached normalized bbox. */
  function projectPoint(lat: number, lon: number, w: number, h: number): { x: number; y: number } {
    const map = mapRef.current;
    if (useMap && map) {
      try {
        const p = map.project([lon, lat]);
        return { x: p.x, y: p.y };
      } catch { /* fall through to normalized */ }
    }
    const bbox = normBboxRef.current;
    if (!bbox) return { x: 0, y: 0 };
    const xN = (lon - bbox.minLon) / Math.max(1e-12, bbox.maxLon - bbox.minLon);
    const yN = 1 - (lat - bbox.minLat) / Math.max(1e-12, bbox.maxLat - bbox.minLat);
    return {
      x: PAD + xN * (w - PAD * 2),
      y: PAD + yN * (h - PAD * 2),
    };
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

    const { raws, bbox } = buildSessionRaws();
    sessionRawsRef.current = raws;
    normBboxRef.current = bbox;

    if (raws.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no GPS data", w / 2, h / 2);
      return;
    }

    const isMulti = visible.length > 1;
    const colorByEnabled = !isMulti && config.colorByChannelId
      && config.colorMin !== undefined && config.colorMax !== undefined;

    for (const r of raws) {
      const px = (i: number) => projectPoint(r.lat[i]!, r.lon[i]!, w, h);

      if (colorByEnabled) {
        const colorBy = r.session.slice.data.get(config.colorByChannelId!);
        const span = config.colorMax! - config.colorMin!;
        ctx.lineWidth = 2.5;
        for (let i = 1; i < r.n; i++) {
          const t = Math.max(0, Math.min(1, ((colorBy?.[i] ?? 0) - config.colorMin!) / span));
          ctx.strokeStyle = lerpColor("#26A69A", "#FFB800", t);
          const a = px(i - 1), b = px(i);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = !isMulti && config.color ? config.color : r.session.color;
        ctx.lineWidth = r.session.isPrimary ? 2.5 : 1.5;
        ctx.beginPath();
        const first = px(0);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < r.n; i++) {
          const p = px(i);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }

      // Cursor dot for this session.
      const idx = findIndexForTime(r.session.slice, tRef.current, r.n);
      const cur = px(idx);
      ctx.fillStyle = !isMulti && config.color ? config.color : r.session.color;
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, r.session.isPrimary ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Status label
    ctx.fillStyle = useMap ? "#D8DCE2" : "#7B8088";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const totalPts = raws.reduce((s, p) => s + p.n, 0);
    ctx.fillText(
      `GPS · ${raws.length} session${raws.length === 1 ? "" : "s"} · ${totalPts} pts`,
      6, 6,
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#16171B] overflow-hidden">
      {useMap && (
        <div ref={mapDivRef} className="absolute inset-0" />
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-crosshair pointer-events-auto"
        style={{ background: useMap ? "transparent" : undefined }}
      />
      <div className="absolute top-1 right-1 flex gap-1 text-[10px] uppercase tracking-wider text-[#7B8088] bg-[#0E0E10cc] px-1.5 py-0.5 rounded-sm pointer-events-none select-none">
        <span>basemap</span>
        <span className="text-[#FFC627]">{basemap}</span>
      </div>
    </div>
  );
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
