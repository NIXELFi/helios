import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import uPlot, { type AlignedData, type Axis, type Options, type Scales, type Series } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { LapRef, LapSelection } from "@helios/lib";
import { perSampleLapDistance, speedToMs } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { useResizeObserver } from "../lib/use-resize-observer";

export interface StripChartChannel {
  id: string;
  color: string;
  /** Per-channel Y range. When unset, falls back to the chart-level
   *  yMin/yMax. This is the MoTeC i2 model: each channel can have its
   *  own scale so a 0–14000 RPM trace and a 0–100 % throttle trace can
   *  share a chart without one being invisible. */
  yMin?: number;
  yMax?: number;
}

export interface StripChartConfig {
  channels: StripChartChannel[];
  /** Default Y range applied to channels that don't set their own. Kept
   *  for backward compatibility with single-scale charts. */
  yMin: number;
  yMax: number;
  /** X axis basis. 'time' is elapsed seconds since session start (the v1
   *  default). 'distance' projects onto per-lap distance in meters and
   *  renders only the laps in the global Main/Ref/Overlays selection.
   *  i2's F9 toggle lives here. Defaults to 'time'. */
  xMode?: "time" | "distance";
}

const DASH_PATTERNS: number[][] = [
  [], [6, 3], [2, 3], [10, 3, 2, 3], [4, 2],
];

function rangeFor(c: StripChartChannel, fallback: StripChartConfig): [number, number] {
  return [c.yMin ?? fallback.yMin, c.yMax ?? fallback.yMax];
}

function formatElapsed(v: number): string {
  if (!Number.isFinite(v)) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const min = Math.floor(abs / 60);
  const sec = abs - min * 60;
  if (min === 0) {
    if (abs < 10) return `${sign}${sec.toFixed(1)}`;
    return `${sign}${Math.round(sec)}`;
  }
  return `${sign}${min}:${Math.round(sec).toString().padStart(2, "0")}`;
}

function formatDistance(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} km`;
  return `${v.toFixed(0)} m`;
}

/** Build aligned data for time-mode rendering — one X is the union of every
 *  visible session's timestamps in seconds, each Y is one (session × channel)
 *  pair, NaN-padded where the session has no sample at that X. */
function buildTimeData(
  overlays: OverlaySession[],
  channels: StripChartChannel[],
): { data: AlignedData; seriesMeta: Array<{ session: OverlaySession; channelIndex: number; lapIndex?: number }> } {
  if (overlays.length === 0) {
    return { data: [new Float64Array(0)], seriesMeta: [] };
  }
  const xSet = new Set<number>();
  for (const o of overlays) {
    const t = o.slice.time;
    for (let i = 0; i < t.length; i++) xSet.add(Number(t[i]) / 1_000_000);
  }
  const x = Float64Array.from([...xSet].sort((a, b) => a - b));
  const xIndex = new Map<number, number>();
  for (let i = 0; i < x.length; i++) xIndex.set(x[i]!, i);
  const ys: Float64Array[] = [];
  const seriesMeta: Array<{ session: OverlaySession; channelIndex: number }> = [];
  for (const session of overlays) {
    for (let ci = 0; ci < channels.length; ci++) {
      const arr = session.slice.data.get(channels[ci]!.id);
      const y = new Float64Array(x.length); y.fill(NaN);
      if (arr) {
        const t = session.slice.time;
        for (let i = 0; i < t.length; i++) {
          const tS = Number(t[i]) / 1_000_000;
          const idx = xIndex.get(tS);
          if (idx !== undefined) y[idx] = arr[i]!;
        }
      }
      ys.push(y);
      seriesMeta.push({ session, channelIndex: ci });
    }
  }
  return { data: [x, ...ys], seriesMeta };
}

/** Build aligned data for distance-mode rendering. For each lap selected via
 *  the global Main/Ref/Overlays state, compute a per-sample distance trace
 *  (resets to 0 at the lap boundary), then per channel emit one series with
 *  X = distance, Y = sample value. Falls back to the primary session's best
 *  lap when no selection is set. */
function buildDistanceData(
  overlays: OverlaySession[],
  channels: StripChartChannel[],
  selection: LapSelection | undefined,
  speedChannelByOverlay: Map<string, { values: Float64Array; unit: string } | null>,
): { data: AlignedData; seriesMeta: Array<{ session: OverlaySession; channelIndex: number; lapIndex: number; role: "main" | "ref" | "overlay" }>; emptyReason?: string } {
  // Resolve which (session, lap) to render. Each entry produces one set of
  // series — one per channel.
  type Entry = { session: OverlaySession; lapIdx: number; role: "main" | "ref" | "overlay" };
  const entries: Entry[] = [];
  const seenKey = new Set<string>();
  function addEntry(role: "main" | "ref" | "overlay", ref: LapRef | null) {
    if (!ref) return;
    const session = overlays.find((o) => o.id === ref.sessionId);
    if (!session || !session.laps) return;
    const lap = session.laps.laps[ref.lapIndex];
    if (!lap) return;
    const k = `${ref.sessionId}|${ref.lapIndex}`;
    if (seenKey.has(k)) return;
    seenKey.add(k);
    entries.push({ session, lapIdx: ref.lapIndex, role });
  }
  if (selection) {
    addEntry("main", selection.main);
    addEntry("ref", selection.ref);
    for (const r of selection.overlays) addEntry("overlay", r);
  }
  // Fallback: primary's best lap.
  if (entries.length === 0) {
    const primary = overlays.find((o) => o.isPrimary);
    if (primary && primary.laps && primary.laps.bestLapIndex >= 0) {
      addEntry("main", { sessionId: primary.id, lapIndex: primary.laps.bestLapIndex });
    }
  }
  if (entries.length === 0) {
    return { data: [new Float64Array(0)], seriesMeta: [],
             emptyReason: "no laps detected — configure detection in the Sessions panel, or pick a lap in the Lap Panel" };
  }

  // Compute per-entry distance arrays (one per entry, length = lap sample count).
  const perEntry: Array<{ entry: Entry; dist: Float64Array; firstSampleIdx: number; lapEndIdx: number }> = [];
  for (const e of entries) {
    const session = e.session;
    const speedInfo = speedChannelByOverlay.get(session.id);
    if (!speedInfo) continue;
    const lap = session.laps!.laps[e.lapIdx]!;
    // perSampleLapDistance returns NaN outside laps, 0 at lap start, accumulating.
    // Call it on the slice's time + speed since that's what the strip-chart
    // already has on hand.
    const dist = perSampleLapDistance(speedInfo.values, speedInfo.unit, session.slice.time, session.laps!);
    // Find lap-relative index range within the slice's time array.
    const t = session.slice.time;
    let i0 = 0, i1 = t.length;
    while (i0 < i1 && Number(t[i0]!) < lap.startUs) i0++;
    let j = i0;
    while (j < i1 && Number(t[j]!) <= lap.endUs) j++;
    if (j - i0 < 2) continue;
    perEntry.push({ entry: e, dist, firstSampleIdx: i0, lapEndIdx: j });
  }
  if (perEntry.length === 0) {
    return { data: [new Float64Array(0)], seriesMeta: [],
             emptyReason: "selected laps don't have a usable speed channel — set one in Lap Config" };
  }

  // Union of all distances within the selected laps.
  const xSet = new Set<number>();
  for (const pe of perEntry) {
    for (let i = pe.firstSampleIdx; i < pe.lapEndIdx; i++) {
      const d = pe.dist[i]!;
      if (Number.isFinite(d)) xSet.add(d);
    }
  }
  const x = Float64Array.from([...xSet].sort((a, b) => a - b));
  const xIndex = new Map<number, number>();
  for (let i = 0; i < x.length; i++) xIndex.set(x[i]!, i);

  const ys: Float64Array[] = [];
  const seriesMeta: Array<{ session: OverlaySession; channelIndex: number; lapIndex: number; role: "main" | "ref" | "overlay" }> = [];
  for (const pe of perEntry) {
    for (let ci = 0; ci < channels.length; ci++) {
      const arr = pe.entry.session.slice.data.get(channels[ci]!.id);
      const y = new Float64Array(x.length); y.fill(NaN);
      if (arr) {
        for (let i = pe.firstSampleIdx; i < pe.lapEndIdx; i++) {
          const d = pe.dist[i]!;
          if (!Number.isFinite(d)) continue;
          const idx = xIndex.get(d);
          if (idx !== undefined) y[idx] = arr[i]!;
        }
      }
      ys.push(y);
      seriesMeta.push({ session: pe.entry.session, channelIndex: ci, lapIndex: pe.entry.lapIdx, role: pe.entry.role });
    }
  }
  return { data: [x, ...ys], seriesMeta };
}

/** Render the datum vertical-lines as DOM children of `u.over`. */
function drawDatums(u: uPlot, datums: number[]): void {
  const over = u.over;
  const existing = over.querySelectorAll<HTMLDivElement>(".helios-datum");
  for (let i = datums.length; i < existing.length; i++) existing[i]!.remove();
  for (let i = 0; i < datums.length; i++) {
    const tUs = datums[i]!;
    const tS = tUs / 1_000_000;
    const x = u.valToPos(tS, "x", false);
    let el = existing[i] as HTMLDivElement | undefined;
    if (!el) {
      el = document.createElement("div");
      el.className = "helios-datum";
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.bottom = "0";
      el.style.width = "1px";
      el.style.background = "#FF6B4A";
      el.style.pointerEvents = "none";
      const label = document.createElement("div");
      label.className = "helios-datum-label";
      label.style.position = "absolute";
      label.style.top = "2px";
      label.style.left = "3px";
      label.style.padding = "0 3px";
      label.style.background = "#FF6B4A";
      label.style.color = "#0E0E10";
      label.style.font = "9px ui-monospace, monospace";
      label.style.borderRadius = "2px";
      label.style.whiteSpace = "nowrap";
      el.appendChild(label);
      over.appendChild(el);
    }
    el.style.left = `${x}px`;
    const label = el.firstElementChild as HTMLDivElement;
    label.textContent = formatElapsed(tS);
  }
}

export function StripChartRender(props: WidgetRenderProps<StripChartConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays, viewState, lapSelection, lapSelectionEmitter } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];
  const isMulti = visible.length > 1;
  const xMode = config.xMode ?? "time";
  // Live-mirror lap selection so distance mode rebuilds when the user picks a
  // different Main/Ref via the lap panel.
  const [liveSelection, setLiveSelection] = useState<LapSelection | undefined>(lapSelection);
  useEffect(() => {
    if (!lapSelectionEmitter) return;
    return lapSelectionEmitter.subscribe((s) => setLiveSelection(s));
  }, [lapSelectionEmitter]);
  // For distance mode, look up speed channels per session via lap config or
  // gps.speed fallback. Captured here so buildDistanceData stays pure.
  const speedByOverlay = useMemo(() => {
    const m = new Map<string, { values: Float64Array; unit: string } | null>();
    if (xMode !== "distance") return m;
    for (const o of visible) {
      const candidates = ["gps.speed", "vehicle.speed"];
      let resolved: { values: Float64Array; unit: string } | null = null;
      for (const id of candidates) {
        const v = o.slice.data.get(id);
        if (!v) continue;
        // Take the unit hint from "the system" — gps.speed is m/s in MoTeC and
        // most ECU exports. speedToMs is tolerant of unknown units.
        resolved = { values: v, unit: id === "gps.speed" ? "m/s" : "km/h" };
        break;
      }
      m.set(o.id, resolved);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xMode, JSON.stringify(visible.map((v) => v.id)), slice]);
  void speedToMs;  // keep import alive — used at the lib boundary

  useEffect(() => {
    if (!containerRef.current) return;
    let buildResult: ReturnType<typeof buildTimeData> | (ReturnType<typeof buildDistanceData> & { emptyReason?: string });
    if (xMode === "distance") {
      buildResult = buildDistanceData(visible, config.channels, liveSelection, speedByOverlay);
    } else {
      buildResult = buildTimeData(visible, config.channels);
    }
    const { data, seriesMeta } = buildResult as { data: AlignedData; seriesMeta: Array<{ session: OverlaySession; channelIndex: number; lapIndex?: number; role?: "main" | "ref" | "overlay" }> };
    const emptyReason = (buildResult as { emptyReason?: string }).emptyReason;

    const scales: Scales = { x: { time: false } };
    const axes: Axis[] = [{
      stroke: "#5A5F66",
      grid: { stroke: "#23252B" },
      values: (_u, splits) => splits.map(xMode === "distance" ? formatDistance : formatElapsed),
      size: 30,
    }];
    const channelScale: string[] = [];
    const groups: Array<{ lo: number; hi: number; id: string; color: string; side: 1 | 3 }> = [];
    for (let ci = 0; ci < config.channels.length; ci++) {
      const ch = config.channels[ci]!;
      const [lo, hi] = rangeFor(ch, config);
      let group = groups.find((g) => g.lo === lo && g.hi === hi);
      if (!group) {
        const id = `s${groups.length}`;
        const side: 1 | 3 = groups.length === 0 ? 3 : 1;
        group = { lo, hi, id, color: ch.color, side };
        groups.push(group);
        if (groups.length <= 2) {
          scales[id] = { range: [lo, hi] };
          axes.push({
            scale: id,
            side,
            stroke: ch.color,
            grid: side === 3 ? { stroke: "#23252B" } : { show: false, stroke: "" },
            size: 60,
          });
        } else {
          group.id = groups[0]!.id;
        }
      }
      channelScale.push(group.id);
    }

    const series: Series[] = [
      {},
      ...seriesMeta.map((meta): Series => {
        const ch = config.channels[meta.channelIndex]!;
        let stroke = ch.color;
        let dashIdx = 0;
        if (xMode === "distance") {
          // Distance mode: color encodes the LAP role (Main = brand yellow,
          // Ref = cyan, Overlays = green) so the user can read the comparison
          // at a glance. Channels within a lap are differentiated by their
          // configured color.
          if (meta.role === "ref") { stroke = "#4FC3F7"; dashIdx = 1; }
          else if (meta.role === "overlay") { stroke = "#9CCC65"; dashIdx = 2; }
          else { stroke = ch.color; dashIdx = 0; }
        } else {
          // Time mode (existing behavior):
          // Single session → keep configured channel colors so multi-channel
          // charts (RPM + throttle) stay visually distinct.
          // Multi-session → session color, dash by channel index.
          stroke = isMulti ? meta.session.color : ch.color;
          dashIdx = isMulti && config.channels.length > 1 ? meta.channelIndex : 0;
        }
        const dash = DASH_PATTERNS[dashIdx % DASH_PATTERNS.length]!;
        return {
          stroke,
          width: 1,
          dash: dash.length ? dash : undefined,
          scale: channelScale[meta.channelIndex] ?? "s0",
          points: { show: false },
        };
      }),
    ];

    const opts: Options = {
      width: containerRef.current.clientWidth || 600,
      height: containerRef.current.clientHeight || 200,
      pxAlign: 0,
      legend: { show: false },
      cursor: { show: false, drag: { x: false, y: false }, sync: undefined, points: { show: false } },
      scales,
      axes,
      series,
    };

    let cleanupPointer: (() => void) | undefined;
    try {
      plotRef.current?.destroy();
      plotRef.current = new uPlot(opts, data, containerRef.current);
      const u = plotRef.current;
      const over = u.over;
      over.style.cursor = xMode === "distance" ? "default" : "crosshair";

      if (xMode === "time") {
        const z0 = viewState?.get().zoomRange;
        if (z0) u.setScale("x", { min: z0.startUs / 1_000_000, max: z0.endUs / 1_000_000 });

        // Pointer modes (time mode only):
        //   plain drag      → scrub cursor
        //   shift + click   → drop a datum
        //   shift + drag    → zoom range
        //   double-click    → reset zoom
        // Distance mode is read-only — interaction would have to translate
        // back through the lap-distance mapping which depends on which lap
        // a sample belongs to; not handled in this iteration.
        const ZOOM_DRAG_PX = 4;
        type Mode = { kind: "none" } | { kind: "scrub" } | { kind: "shift"; startX: number };
        let mode: Mode = { kind: "none" };
        let zoomBox: HTMLDivElement | null = null;

        const xToTimeUs = (clientX: number): number => {
          const rect = over.getBoundingClientRect();
          const localX = clientX - rect.left;
          const raw = Math.round(u.posToVal(localX, "x") * 1_000_000);
          const z = viewState?.get().zoomRange;
          const lo = z ? z.startUs : timeRange.startUs;
          const hi = z ? z.endUs : timeRange.endUs;
          return Math.max(lo, Math.min(hi, raw));
        };
        const localX = (clientX: number): number => clientX - over.getBoundingClientRect().left;

        const ensureZoomBox = () => {
          if (zoomBox) return zoomBox;
          zoomBox = document.createElement("div");
          zoomBox.className = "helios-zoom-box";
          zoomBox.style.position = "absolute";
          zoomBox.style.top = "0";
          zoomBox.style.bottom = "0";
          zoomBox.style.background = "rgba(255, 198, 39, 0.18)";
          zoomBox.style.borderLeft = "1px solid #FFC627";
          zoomBox.style.borderRight = "1px solid #FFC627";
          zoomBox.style.pointerEvents = "none";
          over.appendChild(zoomBox);
          return zoomBox;
        };
        const clearZoomBox = () => { zoomBox?.remove(); zoomBox = null; };

        const onDown = (e: PointerEvent) => {
          if (e.button !== 0) return;
          over.setPointerCapture(e.pointerId);
          if (e.shiftKey && viewState) {
            mode = { kind: "shift", startX: localX(e.clientX) };
          } else {
            mode = { kind: "scrub" };
            cursorEmitter.emit(xToTimeUs(e.clientX));
          }
        };
        const onMove = (e: PointerEvent) => {
          if (mode.kind === "scrub") {
            cursorEmitter.emit(xToTimeUs(e.clientX));
          } else if (mode.kind === "shift") {
            const x0 = mode.startX;
            const x1 = localX(e.clientX);
            if (Math.abs(x1 - x0) >= ZOOM_DRAG_PX) {
              const box = ensureZoomBox();
              box.style.left = `${Math.min(x0, x1)}px`;
              box.style.width = `${Math.abs(x1 - x0)}px`;
            }
          }
        };
        const onUp = (e: PointerEvent) => {
          if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
          if (mode.kind === "shift" && viewState) {
            const x0 = mode.startX;
            const x1 = localX(e.clientX);
            clearZoomBox();
            if (Math.abs(x1 - x0) < ZOOM_DRAG_PX) {
              viewState.addDatum(xToTimeUs(e.clientX));
            } else {
              const a = u.posToVal(Math.min(x0, x1), "x") * 1_000_000;
              const b = u.posToVal(Math.max(x0, x1), "x") * 1_000_000;
              viewState.setZoom({ startUs: Math.round(a), endUs: Math.round(b) });
            }
          }
          mode = { kind: "none" };
        };
        const onDblClick = () => { viewState?.resetZoom(); };

        over.addEventListener("pointerdown", onDown);
        over.addEventListener("pointermove", onMove);
        over.addEventListener("pointerup", onUp);
        over.addEventListener("pointercancel", onUp);
        over.addEventListener("dblclick", onDblClick);
        cleanupPointer = () => {
          over.removeEventListener("pointerdown", onDown);
          over.removeEventListener("pointermove", onMove);
          over.removeEventListener("pointerup", onUp);
          over.removeEventListener("pointercancel", onUp);
          over.removeEventListener("dblclick", onDblClick);
          clearZoomBox();
        };
      }
    } catch (_e) {
      // jsdom canvas may not support 2d context; ignore in test environments
    }

    // Empty-state overlay for distance mode when nothing renderable.
    if (emptyReason) {
      const note = document.createElement("div");
      note.className = "absolute inset-0 flex items-center justify-center text-[11px] text-[#7B8088] text-center px-4 pointer-events-none";
      note.textContent = emptyReason;
      containerRef.current!.appendChild(note);
      return () => {
        cleanupPointer?.();
        plotRef.current?.destroy();
        plotRef.current = null;
        note.remove();
      };
    }

    return () => {
      cleanupPointer?.();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, config, timeRange, cursorEmitter, viewState, JSON.stringify(visible.map((v) => v.id)), xMode, JSON.stringify(liveSelection), speedByOverlay]);

  // Time-mode: subscribe to view-state (zoom + datums). Distance mode
  // ignores datums/zoom for now.
  useEffect(() => {
    if (xMode !== "time") return;
    if (!viewState) return;
    const apply = (state: { datums: number[]; zoomRange: { startUs: number; endUs: number } | null }) => {
      const u = plotRef.current; if (!u) return;
      const z = state.zoomRange;
      if (z) {
        u.setScale("x", { min: z.startUs / 1_000_000, max: z.endUs / 1_000_000 });
      } else {
        const xs = u.data[0] as number[] | Float64Array;
        if (xs.length > 0) {
          u.setScale("x", { min: Number(xs[0]), max: Number(xs[xs.length - 1]) });
        }
      }
      drawDatums(u, state.datums);
    };
    apply(viewState.get());
    return viewState.subscribe(apply);
  }, [viewState, xMode]);

  useEffect(() => {
    if (xMode !== "time") return;
    if (!viewState) return;
    const off = cursorEmitter.subscribe(() => {
      const u = plotRef.current; if (!u) return;
      drawDatums(u, viewState.get().datums);
    });
    return off;
  }, [cursorEmitter, viewState, xMode]);

  useEffect(() => {
    if (xMode !== "time") return;
    const off = cursorEmitter.subscribe((tUs) => {
      const u = plotRef.current; if (!u) return;
      const tS = tUs / 1_000_000;
      const left = u.valToPos(tS, "x", false);
      const over = u.over;
      let line = over.querySelector<HTMLDivElement>(".helios-cursor");
      if (!line) {
        line = document.createElement("div");
        line.className = "helios-cursor";
        line.style.position = "absolute";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = "1px";
        line.style.background = "#FFC627";
        line.style.pointerEvents = "none";
        over.appendChild(line);
      }
      line.style.left = `${left}px`;
    });
    return off;
  }, [cursorEmitter, xMode]);

  const onResize = useCallback(({ width, height }: { width: number; height: number }) => {
    const u = plotRef.current;
    if (!u) return;
    if (width > 0 && height > 0) u.setSize({ width, height });
  }, []);
  useResizeObserver(containerRef, onResize);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#16171B]">
      {config.channels.length > 0 && (
        <div className="absolute top-1 right-1 flex flex-row gap-1 z-10 pointer-events-none max-w-[80%] flex-wrap justify-end">
          {config.channels.map((c, i) => (
            <div
              key={i}
              className="flex items-center gap-1 text-[9px] text-[#D8DCE2] bg-[#0E0E10cc] px-1 py-px rounded-sm"
            >
              <span className="inline-block w-1.5 h-1.5" style={{ background: c.color }} />
              <span className="font-mono-num leading-none">{c.id || "—"}</span>
            </div>
          ))}
        </div>
      )}
      {/* X-mode pill: shows current mode and lets the user toggle without
          opening the config panel. Mirrors i2's F9 toggle. */}
      <div className="absolute bottom-1 left-1 z-10 text-[9px]">
        <span className="bg-[#0E0E10cc] text-[#7B8088] px-1.5 py-px rounded-sm font-mono-num">
          x = {xMode === "distance" ? "distance" : "time"}
        </span>
      </div>
    </div>
  );
}
