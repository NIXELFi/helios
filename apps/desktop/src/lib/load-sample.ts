import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";
import { detectLaps } from "@helios/lib";
import { type LoadedSession, colorForIndex } from "./session";
import { defaultLapConfig, lapInputsFor, loadLapConfig } from "./lap-config";
import {
  applyOverridesToStore, loadChannelOverrides, saveChannelOverrides,
} from "./channel-overrides";

export interface SampleEntry { id: string; label: string; resource: string; }

// The public build ships NO bundled CSVs — neither real team data nor synthetic
// demos. On launch with no recent user sessions, App.tsx shows the "Open a CSV
// with ⌘O to get started" empty state (its zero-session boot strand). Add an
// entry here only for a non-sensitive fixture you intend to ship to users.
export const SAMPLES: SampleEntry[] = [];

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
    // Apply saved overrides before lap detection — picked speed/gps
    // channels could route through an override.
    const savedOverrides = loadChannelOverrides(s.id);
    const channelOverrides = applyOverridesToStore(store, savedOverrides);
    if (
      Object.keys(channelOverrides).length !==
      Object.keys(savedOverrides).length
    ) {
      saveChannelOverrides(s.id, channelOverrides);
    }
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
      channelOverrides,
    };
  });
}
