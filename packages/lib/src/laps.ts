/* Lap detection and lap-aware aggregates.
 *
 * A "Lap" is a half-open time segment [startUs, endUs) discovered by detecting
 * crossings of a user-defined trigger: a GPS start-finish line, the rising
 * edge of a beacon channel, the rising edge of an arbitrary expression
 * applied to the data, or a manually-entered list of crossing timestamps.
 *
 * The first segment (before the first crossing) is exposed as lap 0 marked
 * untrusted ("out lap"); the last segment (after the final crossing) is the
 * trailing untrusted lap ("in lap"). Laps in between are numbered 1..N and
 * marked trusted. The user can flip the trusted flag manually.
 *
 * Distance per lap is computed as the cumulative integral of a speed channel
 * (m/s, km/h, or mph — auto-converted via the channel's units) over the lap
 * window. When no speed channel is available callers can fall back to
 * great-circle GPS arc length.
 */

import type { Ast } from "./math-expr";
import { evalAst, parseExpr } from "./math-expr";

// ─── types ──────────────────────────────────────────────────────────────────

export interface Lap {
  /** 1-based for trusted laps; 0 = warmup before the first crossing; the
   *  trailing post-final-crossing segment gets the next free number after
   *  the last trusted lap and is also marked untrusted. */
  index: number;
  startUs: number;
  endUs: number;
  durationS: number;
  /** Cumulative distance covered during the lap, in meters. NaN when not
   *  computed (no speed channel and no GPS fallback). */
  distanceM: number;
  /** Whether to count this lap in best-lap, mean-lap, statistics. Out laps
   *  and in laps default to false; user-entered manual laps default to true. */
  trusted: boolean;
  /** Optional free-form note (driver, stint, "left rear flat", etc.). Persisted. */
  note?: string;
}

export interface LapSet {
  laps: Lap[];
  /** Index into `laps[]` of the fastest trusted lap (lowest durationS).
   *  -1 when there is no trusted lap. */
  bestLapIndex: number;
  /** Hash of the inputs used to compute this set, so callers can decide
   *  whether to recompute. Includes config and source data fingerprint. */
  cacheKey: string;
}

export type LapDetectionMode = "none" | "gps_line" | "beacon" | "expression" | "manual";

export interface LapDetectionConfig {
  mode: LapDetectionMode;
  gpsLine?: GpsLineConfig;
  beacon?: BeaconConfig;
  expression?: ExpressionConfig;
  manual?: ManualConfig;
  /** Channel id holding the speed signal used for distance integration. When
   *  undefined, distanceM defaults to NaN. Helios convention: any channel
   *  with units of "m/s", "km/h" or "mph" is acceptable. */
  speedChannelId?: string;
  /** Global note overrides per lap index. Used by the UI to mark in/out laps
   *  or attach driver labels without recomputing the detector. */
  notesByIndex?: Record<number, string>;
  /** Forced trust override per lap index (defaults to detector output). */
  trustByIndex?: Record<number, boolean>;
}

export interface GpsLineConfig {
  latChannelId: string;
  lonChannelId: string;
  /** Center of the start-finish line. */
  centerLat: number;
  centerLon: number;
  /** Half-width of the line, in meters. A crossing must occur within this
   *  radius from the center to count. Default ~30 m for car-scale tracks;
   *  smaller for karting. */
  radiusM: number;
  /** Optional: line orientation in degrees clockwise from north (0–360).
   *  When set, only crossings with the dot product of car-velocity onto
   *  the line-perpendicular sign-matching the configured direction count.
   *  Eliminates "wrong-direction" crossings when laps re-cross the line on
   *  the opposite side. */
  headingDeg?: number;
}

export interface BeaconConfig {
  /** Numeric channel that pulses high (>= threshold) at the start-finish
   *  line. Each rising edge counts as a crossing. */
  channelId: string;
  threshold: number;
}

export interface ExpressionConfig {
  /** Boolean math-expr; rising edges of (expr != 0) are crossings.
   *  Channel refs follow the Helios math syntax (`engine.rpm`, `[Engine Speed]`). */
  expression: string;
}

export interface ManualConfig {
  crossingsUs: number[];
}

// ─── data interface ─────────────────────────────────────────────────────────

/** Adapter the detector reads from, so it stays decoupled from ChannelStore. */
export interface LapInputs {
  /** Sorted, monotonically-increasing time index in microseconds for the
   *  base rate group used by the detector. Typically the highest-rate group
   *  in the session. */
  timeUs: BigInt64Array;
  /** Look up a channel's per-sample values aligned to `timeUs`. Caller is
   *  responsible for cross-rate resampling via the same binary-search logic
   *  the math channel resolver uses. Returns undefined when missing. */
  resolve: (channelId: string) => Float64Array | undefined;
  /** The channel's display units, used by `speed→m/s` conversion. Returns
   *  undefined when the channel doesn't exist. */
  unitsOf: (channelId: string) => string | undefined;
}

// ─── public API ─────────────────────────────────────────────────────────────

export function detectLaps(cfg: LapDetectionConfig, inputs: LapInputs): LapSet {
  const cacheKey = hashConfig(cfg, inputs.timeUs);
  if (cfg.mode === "none" || inputs.timeUs.length < 2) {
    return { laps: [], bestLapIndex: -1, cacheKey };
  }
  const crossings = findCrossings(cfg, inputs);
  const laps = buildLaps(crossings, inputs.timeUs, cfg);
  computeDistances(laps, cfg, inputs);
  applyOverrides(laps, cfg);
  const bestLapIndex = findBestLap(laps);
  return { laps, bestLapIndex, cacheKey };
}

/** Return the lap that contains the given timestamp, or null. Trailing
 *  untrusted laps are eligible — caller is responsible for filtering. */
export function lapAt(set: LapSet, tUs: number): Lap | null {
  for (const l of set.laps) {
    if (tUs >= l.startUs && tUs < l.endUs) return l;
  }
  // Tail-inclusive at the very end of the data so final samples don't drop out.
  const last = set.laps[set.laps.length - 1];
  if (last && tUs >= last.startUs && tUs <= last.endUs) return last;
  return null;
}

/** Return the index in `laps[]` of the lap containing `tUs`, or -1. */
export function lapIndexAt(set: LapSet, tUs: number): number {
  for (let i = 0; i < set.laps.length; i++) {
    const l = set.laps[i]!;
    if (tUs >= l.startUs && tUs < l.endUs) return i;
  }
  if (set.laps.length === 0) return -1;
  // Tail-inclusive: the very last sample of the session sits exactly at
  // last.endUs and belongs to the last lap. Guard with startUs so timestamps
  // that precede the first lap are correctly reported as -1.
  const last = set.laps[set.laps.length - 1]!;
  return tUs >= last.startUs && tUs <= last.endUs ? set.laps.length - 1 : -1;
}

// ─── crossings ──────────────────────────────────────────────────────────────

function findCrossings(cfg: LapDetectionConfig, inputs: LapInputs): number[] {
  switch (cfg.mode) {
    case "gps_line":   return cfg.gpsLine ? gpsLineCrossings(cfg.gpsLine, inputs) : [];
    case "beacon":     return cfg.beacon ? beaconCrossings(cfg.beacon, inputs) : [];
    case "expression": return cfg.expression ? expressionCrossings(cfg.expression, inputs) : [];
    case "manual":     return cfg.manual ? sortedCopy(cfg.manual.crossingsUs) : [];
    case "none":       return [];
  }
}

/** Detect samples where the GPS path crosses the start-finish segment.
 *  We check segment-segment intersection between consecutive GPS positions
 *  and a perpendicular line at (centerLat, centerLon) of length 2*radiusM
 *  oriented perpendicular to `headingDeg` (or east-west if heading omitted).
 *
 *  Returns timestamps interpolated to the crossing instant rather than the
 *  bracketing sample. Crossings within ~MIN_LAP_SECONDS of the previous one
 *  are suppressed to avoid double counts when GPS noise causes a sample to
 *  re-cross the line. */
const MIN_LAP_SECONDS = 5;
const NULL_ISLAND_DEG = 0.5;
const M_PER_DEG_LAT = 111_320;

function gpsLineCrossings(g: GpsLineConfig, inputs: LapInputs): number[] {
  const lat = inputs.resolve(g.latChannelId);
  const lon = inputs.resolve(g.lonChannelId);
  if (!lat || !lon) return [];
  const t = inputs.timeUs;
  const n = Math.min(lat.length, lon.length, t.length);
  if (n < 2) return [];

  // Treat lat/lon near (0,0) as "no fix"; common for sparse GPS samples.
  const valid = (i: number) =>
    Number.isFinite(lat[i]!) && Number.isFinite(lon[i]!) &&
    (Math.abs(lat[i]!) > NULL_ISLAND_DEG || Math.abs(lon[i]!) > NULL_ISLAND_DEG);

  const cosLat0 = Math.cos((g.centerLat * Math.PI) / 180);
  const mPerDegLon = M_PER_DEG_LAT * cosLat0;
  // Local meter-projected coords centered on the start-finish point.
  const proj = (la: number, lo: number) => ({
    x: (lo - g.centerLon) * mPerDegLon,
    y: (la - g.centerLat) * M_PER_DEG_LAT,
  });

  // Line direction (perpendicular to the racing-direction heading). Heading is
  // clockwise from north; perpendicular is heading+90° in compass terms, which
  // in math (x=east, y=north) is the unit vector (cos(heading), sin(heading)) →
  // the line direction is (sin(heading), -cos(heading))? — derivation:
  //   compass heading H° measured clockwise from north
  //   heading direction in (east, north) = (sin H, cos H)
  //   perpendicular (line direction) = (cos H, -sin H)
  const Hrad = ((g.headingDeg ?? 0) * Math.PI) / 180;
  const lineDx = Math.cos(Hrad);
  const lineDy = -Math.sin(Hrad);
  // Endpoints of the start-finish segment in local meters.
  const ax = -g.radiusM * lineDx, ay = -g.radiusM * lineDy;
  const bx =  g.radiusM * lineDx, by =  g.radiusM * lineDy;

  // Perpendicular direction (= heading direction). When headingDeg unset, we
  // accept either direction; a race-direction filter is a nice-to-have.
  const perpX = Math.sin(Hrad), perpY = Math.cos(Hrad);
  const directional = g.headingDeg !== undefined && Number.isFinite(g.headingDeg);

  const crossings: number[] = [];
  let prev: { x: number; y: number; t: number } | null = null;
  let lastEmitT = -Infinity;

  for (let i = 0; i < n; i++) {
    if (!valid(i)) { prev = null; continue; }
    const p = proj(lat[i]!, lon[i]!);
    const tUs = Number(t[i]!);
    if (prev) {
      const u = segIntersect(prev.x, prev.y, p.x, p.y, ax, ay, bx, by);
      if (u !== null) {
        const dx = p.x - prev.x, dy = p.y - prev.y;
        if (!directional || (dx * perpX + dy * perpY) > 0) {
          const tCross = prev.t + (tUs - prev.t) * u;
          if (tCross - lastEmitT > MIN_LAP_SECONDS * 1_000_000) {
            crossings.push(Math.round(tCross));
            lastEmitT = tCross;
          }
        }
      }
    }
    prev = { x: p.x, y: p.y, t: tUs };
  }
  return crossings;
}

/** Return the parameter `u` in [0,1] along (p1→p2) where segment (p1,p2)
 *  intersects segment (a,b), or null if there's no intersection. */
function segIntersect(
  p1x: number, p1y: number, p2x: number, p2y: number,
  ax: number,  ay: number,  bx: number,  by: number,
): number | null {
  const r1x = p2x - p1x, r1y = p2y - p1y;
  const r2x = bx - ax,  r2y = by - ay;
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < 1e-12) return null;
  const dx = ax - p1x, dy = ay - p1y;
  const u = (dx * r2y - dy * r2x) / den;
  const v = (dx * r1y - dy * r1x) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return u;
}

function beaconCrossings(b: BeaconConfig, inputs: LapInputs): number[] {
  const ch = inputs.resolve(b.channelId);
  if (!ch) return [];
  const t = inputs.timeUs;
  const n = Math.min(ch.length, t.length);
  const out: number[] = [];
  let lastEmitT = -Infinity;
  for (let i = 1; i < n; i++) {
    const a = ch[i - 1]!, c = ch[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
    if (a < b.threshold && c >= b.threshold) {
      const tUs = Number(t[i]!);
      if (tUs - lastEmitT > MIN_LAP_SECONDS * 1_000_000) {
        out.push(tUs);
        lastEmitT = tUs;
      }
    }
  }
  return out;
}

function expressionCrossings(e: ExpressionConfig, inputs: LapInputs): number[] {
  const parsed = parseExpr(e.expression);
  if (!parsed.ast) return [];
  const ast = parsed.ast;
  const refs = parsed.refs;
  const cols = new Map<string, Float64Array>();
  for (const r of refs) {
    const c = inputs.resolve(r);
    if (!c) return [];
    cols.set(r, c);
  }
  const t = inputs.timeUs;
  const n = t.length;
  const sample: Record<string, number | undefined> = Object.create(null);
  const out: number[] = [];
  let prev = 0;
  let lastEmitT = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const [name, col] of cols) sample[name] = col[i];
    const v = evalAst(ast, (name) => sample[name]) ? 1 : 0;
    if (i > 0 && prev === 0 && v === 1) {
      const tUs = Number(t[i]!);
      if (tUs - lastEmitT > MIN_LAP_SECONDS * 1_000_000) {
        out.push(tUs);
        lastEmitT = tUs;
      }
    }
    prev = v;
  }
  // Touch ast to keep tree-shakers from removing the import in builds that
  // never call expressionCrossings — the Ast type is nominal-only otherwise.
  void (ast as Ast);
  return out;
}

// ─── lap construction ───────────────────────────────────────────────────────

function buildLaps(
  crossings: number[],
  timeUs: BigInt64Array,
  _cfg: LapDetectionConfig,
): Lap[] {
  if (timeUs.length < 2) return [];
  const startUs = Number(timeUs[0]!);
  const endUs = Number(timeUs[timeUs.length - 1]!);
  if (crossings.length === 0) {
    // No crossings at all — treat the entire session as a single untrusted
    // lap so widgets can still render something.
    return [{
      index: 0, startUs, endUs,
      durationS: (endUs - startUs) / 1_000_000,
      distanceM: NaN, trusted: false,
    }];
  }
  const laps: Lap[] = [];
  // Out lap before the first crossing
  if (crossings[0]! > startUs + 1) {
    laps.push({
      index: 0, startUs, endUs: crossings[0]!,
      durationS: (crossings[0]! - startUs) / 1_000_000,
      distanceM: NaN, trusted: false,
    });
  }
  for (let i = 0; i < crossings.length - 1; i++) {
    const a = crossings[i]!, b = crossings[i + 1]!;
    laps.push({
      index: i + 1, startUs: a, endUs: b,
      durationS: (b - a) / 1_000_000,
      distanceM: NaN, trusted: true,
    });
  }
  // In lap after the final crossing
  const tail = crossings[crossings.length - 1]!;
  if (endUs > tail + 1) {
    const lastTrustedNum = laps.filter((l) => l.trusted).length;
    laps.push({
      index: lastTrustedNum + 1, startUs: tail, endUs,
      durationS: (endUs - tail) / 1_000_000,
      distanceM: NaN, trusted: false,
    });
  }
  return laps;
}

function computeDistances(laps: Lap[], cfg: LapDetectionConfig, inputs: LapInputs): void {
  if (!cfg.speedChannelId) return;
  const speed = inputs.resolve(cfg.speedChannelId);
  if (!speed) return;
  const factor = speedToMs(inputs.unitsOf(cfg.speedChannelId) ?? "m/s");
  const t = inputs.timeUs;
  const n = Math.min(speed.length, t.length);
  for (const lap of laps) {
    let acc = 0;
    let prevT = NaN, prevV = NaN;
    for (let i = 0; i < n; i++) {
      const tUs = Number(t[i]!);
      if (tUs < lap.startUs) continue;
      if (tUs > lap.endUs) break;
      const v = speed[i]! * factor;
      if (Number.isFinite(prevV) && Number.isFinite(v)) {
        const dt = (tUs - prevT) / 1_000_000;
        acc += 0.5 * (prevV + v) * dt;
      }
      prevT = tUs;
      prevV = v;
    }
    lap.distanceM = acc;
  }
}

/** Multiplier to convert from `unit` to m/s. */
export function speedToMs(unit: string): number {
  const u = unit.trim().toLowerCase();
  if (u === "m/s" || u === "ms" || u === "") return 1;
  if (u === "km/h" || u === "kph") return 1 / 3.6;
  if (u === "mph") return 0.44704;
  if (u === "kn" || u === "kt" || u === "knots") return 0.514444;
  return 1;  // unknown — treat as m/s
}

function applyOverrides(laps: Lap[], cfg: LapDetectionConfig): void {
  if (cfg.notesByIndex) {
    for (const lap of laps) {
      const note = cfg.notesByIndex[lap.index];
      if (note !== undefined) lap.note = note;
    }
  }
  if (cfg.trustByIndex) {
    for (const lap of laps) {
      const t = cfg.trustByIndex[lap.index];
      if (t !== undefined) lap.trusted = t;
    }
  }
}

function findBestLap(laps: Lap[]): number {
  let best = -1, bestT = Infinity;
  for (let i = 0; i < laps.length; i++) {
    const l = laps[i]!;
    if (!l.trusted) continue;
    if (l.durationS < bestT) { best = i; bestT = l.durationS; }
  }
  return best;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sortedCopy(arr: number[]): number[] {
  const c = arr.slice();
  c.sort((a, b) => a - b);
  return c;
}

function hashConfig(cfg: LapDetectionConfig, t: BigInt64Array): string {
  // Cheap fingerprint — full equality isn't required, just enough that two
  // identical configs against identical data produce the same key while
  // distinct configs collide rarely. Good enough for cache invalidation.
  const json = JSON.stringify({
    m: cfg.mode,
    g: cfg.gpsLine,
    b: cfg.beacon,
    e: cfg.expression,
    n: cfg.manual?.crossingsUs.length,
    s: cfg.speedChannelId,
    no: cfg.notesByIndex,
    tr: cfg.trustByIndex,
    L: t.length,
    T0: t.length > 0 ? Number(t[0]!) : 0,
    Tn: t.length > 0 ? Number(t[t.length - 1]!) : 0,
  });
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  return `${cfg.mode}-${(h >>> 0).toString(16)}`;
}

// ─── lap-aware aggregates ───────────────────────────────────────────────────

/** Compute per-sample lap-aggregate output for `lap_max(channel)`-style ops.
 *  At each sample t, returns the aggregate value over the lap that contains
 *  t. Samples outside any lap return NaN. */
export type LapOp = "lap_max" | "lap_min" | "lap_mean" | "lap_first" | "lap_last";

export function lapAggregate(
  op: LapOp,
  values: Float64Array,
  timeUs: BigInt64Array,
  set: LapSet,
): Float64Array {
  const n = Math.min(values.length, timeUs.length);
  const out = new Float64Array(n);
  if (set.laps.length === 0) { out.fill(NaN); return out; }

  // Cache one aggregate value per lap, then broadcast back to samples.
  const perLap: number[] = new Array(set.laps.length).fill(NaN);
  for (let li = 0; li < set.laps.length; li++) {
    const lap = set.laps[li]!;
    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
    let first = NaN, last = NaN;
    for (let i = 0; i < n; i++) {
      const tUs = Number(timeUs[i]!);
      if (tUs < lap.startUs) continue;
      // Laps are half-open [startUs, endUs) — exclude the boundary sample
      // so it isn't double-attributed to both this lap and the next.
      if (tUs >= lap.endUs) break;
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
      if (Number.isNaN(first)) first = v;
      last = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v; cnt++;
    }
    let v: number;
    switch (op) {
      case "lap_max":   v = cnt === 0 ? NaN : mx; break;
      case "lap_min":   v = cnt === 0 ? NaN : mn; break;
      case "lap_mean":  v = cnt === 0 ? NaN : sum / cnt; break;
      case "lap_first": v = first; break;
      case "lap_last":  v = last; break;
    }
    perLap[li] = v;
  }
  // Broadcast: scan once, advancing the lap pointer.
  let li = 0;
  for (let i = 0; i < n; i++) {
    const tUs = Number(timeUs[i]!);
    while (li < set.laps.length && tUs >= set.laps[li]!.endUs) li++;
    if (li >= set.laps.length) { out[i] = NaN; continue; }
    const lap = set.laps[li]!;
    if (tUs < lap.startUs) { out[i] = NaN; continue; }
    out[i] = perLap[li]!;
  }
  return out;
}

/** Per-sample distance trace within each lap, in meters. distanceM resets to
 *  0 at every lap boundary. Useful as a virtual `system.lap_distance` channel
 *  and for distance-based X axes on time-charts.
 *
 *  When the speed channel resolution is missing or a sample's speed is NaN,
 *  the trace holds its last value rather than emitting NaN — analyzing
 *  distance traces with gaps is hard to reason about. Out-of-lap samples
 *  return NaN. */
export function perSampleLapDistance(
  speed: Float64Array,
  speedUnit: string,
  timeUs: BigInt64Array,
  set: LapSet,
): Float64Array {
  const n = Math.min(speed.length, timeUs.length);
  const out = new Float64Array(n);
  out.fill(NaN);
  if (set.laps.length === 0) return out;
  const factor = speedToMs(speedUnit);
  let li = 0;
  let acc = 0;
  let prevTus = -1;
  let prevV = NaN;
  for (let i = 0; i < n; i++) {
    const tUs = Number(timeUs[i]!);
    while (li < set.laps.length && tUs >= set.laps[li]!.endUs) {
      li++;
      acc = 0;
      prevTus = -1;
      prevV = NaN;
    }
    if (li >= set.laps.length) break;
    const lap = set.laps[li]!;
    if (tUs < lap.startUs) continue;
    const v = speed[i]! * factor;
    if (prevTus < 0) {
      acc = 0;
    } else {
      const dt = (tUs - prevTus) / 1_000_000;
      const a = Number.isFinite(prevV) ? prevV : 0;
      const b = Number.isFinite(v) ? v : a;
      acc += 0.5 * (a + b) * dt;
    }
    out[i] = acc;
    prevTus = tUs;
    if (Number.isFinite(v)) prevV = v;
  }
  return out;
}

// ─── lap selection (overlay state) ──────────────────────────────────────────

export interface LapRef {
  sessionId: string;
  /** Index into LapSet.laps[]. */
  lapIndex: number;
}

export interface LapSelection {
  /** Primary lap drawn in full color. */
  main: LapRef | null;
  /** Reference lap drawn in dashed/black; deltas are computed against this. */
  ref: LapRef | null;
  /** Additional overlays (drawn dashed). */
  overlays: LapRef[];
}

export type LapSelectionListener = (s: LapSelection) => void;

/** Pub/sub holding the current Main/Ref/Overlays lap selection. Like
 *  CursorEmitter and ViewStateEmitter, lives at App level and survives
 *  workspace switches. Resets on app restart. */
export class LapSelectionEmitter {
  #state: LapSelection = { main: null, ref: null, overlays: [] };
  #listeners = new Set<LapSelectionListener>();

  subscribe(cb: LapSelectionListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  get(): LapSelection { return this.#state; }

  set(state: LapSelection): void {
    this.#state = state;
    // Snapshot first: a listener may subscribe/unsubscribe during its own
    // callback, and mutating the Set mid-iteration would skip or double-fire.
    for (const cb of [...this.#listeners]) cb(state);
  }

  setMain(ref: LapRef | null): void {
    this.set({ ...this.#state, main: ref });
  }
  setRef(ref: LapRef | null): void {
    this.set({ ...this.#state, ref: ref });
  }
  toggleOverlay(ref: LapRef): void {
    const eq = (a: LapRef, b: LapRef) => a.sessionId === b.sessionId && a.lapIndex === b.lapIndex;
    const has = this.#state.overlays.some((r) => eq(r, ref));
    const next = has
      ? this.#state.overlays.filter((r) => !eq(r, ref))
      : [...this.#state.overlays, ref];
    this.set({ ...this.#state, overlays: next });
  }
  clearOverlays(): void {
    this.set({ ...this.#state, overlays: [] });
  }
  /** Drop any selection that points at a session not in `validSessionIds`.
   *  Called by App when a session toggles invisible or is removed. */
  prune(validSessionIds: Set<string>): void {
    const main = this.#state.main && validSessionIds.has(this.#state.main.sessionId)
      ? this.#state.main : null;
    const ref = this.#state.ref && validSessionIds.has(this.#state.ref.sessionId)
      ? this.#state.ref : null;
    const overlays = this.#state.overlays.filter((r) => validSessionIds.has(r.sessionId));
    if (main !== this.#state.main || ref !== this.#state.ref
        || overlays.length !== this.#state.overlays.length) {
      this.set({ main, ref, overlays });
    }
  }
}
