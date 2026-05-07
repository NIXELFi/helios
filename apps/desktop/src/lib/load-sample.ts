import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";
import { detectLaps } from "@helios/lib";
import { type LoadedSession, colorForIndex } from "./session";
import { defaultLapConfig, lapInputsFor, loadLapConfig } from "./lap-config";

export interface SampleEntry { id: string; label: string; resource: string; }

export const SAMPLES: SampleEntry[] = [
  { id: "sdm26-synthetic-multi-lap", label: "SDM26 synthetic 4 laps (demo)",       resource: "samples/sdm26-synthetic-multi-lap.csv" },
  { id: "driver-tryout-good-gps",    label: "Driver tryout 4/16 — Kaden (good GPS)", resource: "samples/driver-tryout-good-gps.csv" },
  { id: "sdm26-best-accel",          label: "SDM26 5/3 — Best Accel",               resource: "samples/sdm26-best-accel.csv" },
  { id: "sdm26-synthetic",           label: "SDM26 synthetic lap (demo)",           resource: "samples/sdm26-synthetic-lap.csv" },
];

export async function loadSampleSession(resourceRelPath: string): Promise<ChannelStore> {
  const store = new ChannelStore();
  const csv = await resolveResource(resourceRelPath);
  const yaml = await resolveResource("channels.yaml");
  await loadCsvIntoStore(store, csv, yaml);
  return store;
}

export interface LoadProgress {
  /** Short label of the current step shown to the user. */
  label: string;
  /** Number of sessions finished loading so far. */
  loaded: number;
  /** Total sessions to load. */
  total: number;
}

/** Load every bundled sample into its own LoadedSession. The first sample is
 *  visible by default; subsequent ones load hidden so the overlay is opt-in.
 *  When `onProgress` is supplied, fires once before each session and once
 *  after every session is loaded — useful for driving a loading-screen UI.
 *
 *  Lap detection: the saved per-session config from localStorage takes
 *  precedence; otherwise a sensible default is picked from the channels
 *  available (GPS line, beacon channel, or none). Laps are detected
 *  immediately so widgets that read them render with structure on first
 *  paint instead of populating async. */
export async function loadAllSessions(
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadedSession[]> {
  const total = SAMPLES.length;
  const stores: ChannelStore[] = [];
  for (let i = 0; i < SAMPLES.length; i++) {
    const s = SAMPLES[i]!;
    onProgress?.({ label: `Loading ${s.label}`, loaded: i, total });
    stores.push(await loadSampleSession(s.resource));
  }
  onProgress?.({ label: "Sessions ready", loaded: total, total });
  return SAMPLES.map((s, i) => {
    const store = stores[i]!;
    const cfg = loadLapConfig(s.id) ?? defaultLapConfig(store);
    const laps = cfg.mode === "none" ? null : detectLaps(cfg, lapInputsFor(store));
    return {
      id: s.id,
      label: s.label,
      store,
      color: colorForIndex(i),
      visible: i === 0,
      lapConfig: cfg,
      laps,
    };
  });
}
