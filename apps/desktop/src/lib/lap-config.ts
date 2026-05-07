/* Per-session lap detection config storage and a ChannelStore→LapInputs
 * adapter. Storage is keyed by session id (the bundled samples have stable
 * filename-derived ids; user-loaded files get hashed deterministic ids).
 *
 * Default config: when a session has gps.lat / gps.lon, we auto-pick gps_line
 * mode pointing at the median GPS point so the user gets an immediate
 * single-lap segmentation. They can refine via the Lap Config dialog.
 */

import type { ChannelStore, RateGroup } from "@helios/store";
import type { LapDetectionConfig, LapInputs } from "@helios/lib";

const STORAGE_KEY = "helios.lap-config.v1";

interface StoredState {
  version: 1;
  bySession: Record<string, LapDetectionConfig>;
}

export function loadAllLapConfigs(): Record<string, LapDetectionConfig> {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.version === 1) return parsed.bySession;
  } catch { /* ignore */ }
  return {};
}

export function saveLapConfig(sessionId: string, cfg: LapDetectionConfig): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllLapConfigs();
  all[sessionId] = cfg;
  const state: StoredState = { version: 1, bySession: all };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadLapConfig(sessionId: string): LapDetectionConfig | null {
  return loadAllLapConfigs()[sessionId] ?? null;
}

/** Best-guess default config for a freshly-loaded session. Picks gps_line
 *  mode when GPS channels exist, beacon mode when a `system.beacon` channel
 *  exists, else `none`. The user always has the chance to override via the
 *  Lap Config dialog. */
export function defaultLapConfig(store: ChannelStore): LapDetectionConfig {
  const has = (id: string) => store.get(id) !== undefined;
  // Prefer beacon if available — it's unambiguous.
  if (has("system.beacon")) {
    return {
      mode: "beacon",
      beacon: { channelId: "system.beacon", threshold: 0.5 },
      speedChannelId: pickSpeedChannel(store),
    };
  }
  if (has("gps.lat") && has("gps.lon")) {
    const center = pickGpsLineCenter(store);
    if (center) {
      return {
        mode: "gps_line",
        gpsLine: {
          latChannelId: "gps.lat", lonChannelId: "gps.lon",
          centerLat: center.lat, centerLon: center.lon,
          radiusM: 30,
        },
        speedChannelId: pickSpeedChannel(store),
      };
    }
  }
  return { mode: "none" };
}

/** Pick a sensible speed channel for distance integration. Preference order:
 *  gps.speed → engine.wheel_speed_avg → engine.speed → first channel whose
 *  units suggest velocity. */
function pickSpeedChannel(store: ChannelStore): string | undefined {
  const candidates = ["gps.speed", "vehicle.speed", "wheel.speed_avg", "engine.wheel_speed_avg"];
  for (const id of candidates) if (store.get(id)) return id;
  for (const meta of store.list()) {
    const u = meta.units.toLowerCase();
    if (u === "m/s" || u === "km/h" || u === "kph" || u === "mph") return meta.id;
  }
  return undefined;
}

/** Pick the GPS-line center as the median of valid GPS points. Returns null
 *  when no usable GPS data exists. The "median" is approximated as the
 *  midpoint of the bbox — good enough as a starting suggestion that the user
 *  will refine. */
function pickGpsLineCenter(store: ChannelStore): { lat: number; lon: number } | null {
  const lat = readChannel(store, "gps.lat");
  const lon = readChannel(store, "gps.lon");
  if (!lat || !lon) return null;
  let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity, found = false;
  const n = Math.min(lat.length, lon.length);
  for (let i = 0; i < n; i++) {
    const la = lat[i]!, lo = lon[i]!;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (Math.abs(la) < 0.5 && Math.abs(lo) < 0.5) continue; // null island
    if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
    if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo;
    found = true;
  }
  if (!found) return null;
  return { lat: (mnLa + mxLa) / 2, lon: (mnLo + mxLo) / 2 };
}

function readChannel(store: ChannelStore, id: string): Float64Array | undefined {
  const g = store.groupOf(id);
  return g?.columns.get(id);
}

/** Build a LapInputs adapter that reads from a ChannelStore. Resampling
 *  cross-rate channels to the base group's time axis happens lazily — only
 *  when `resolve()` is called. */
export function lapInputsFor(store: ChannelStore): LapInputs {
  const groups = store.groups();
  if (groups.length === 0) {
    return {
      timeUs: new BigInt64Array(0),
      resolve: () => undefined,
      unitsOf: () => undefined,
    };
  }
  const base: RateGroup = groups.reduce((a, b) => (a.time.length >= b.time.length ? a : b));
  return {
    timeUs: base.time,
    resolve: (id: string) => {
      const g = store.groupOf(id);
      if (!g) return undefined;
      const col = g.columns.get(id);
      if (!col) return undefined;
      if (g.id === base.id) return col;
      // Cross-rate: resample to base.time via binary search.
      const out = new Float64Array(base.time.length);
      const t = g.time;
      for (let i = 0; i < base.time.length; i++) {
        const target = base.time[i]!;
        let lo = 0, hi = t.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (t[mid]! <= target) lo = mid + 1; else hi = mid;
        }
        const idx = Math.max(0, lo - 1);
        out[i] = col[idx]!;
      }
      return out;
    },
    unitsOf: (id: string) => store.get(id)?.units,
  };
}
