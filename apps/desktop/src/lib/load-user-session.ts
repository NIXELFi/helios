/* User-loaded session pipeline: arbitrary CSV path → LoadedSession.
 *
 * Mirrors loadAllSessions but works on a single user-supplied path instead of
 * a bundled-resource relative path. The bundled channels.yaml is still
 * resolved via resolveResource so user files inherit the same channel
 * registry, units, and aliases as bundled samples. */

import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";
import { detectLaps } from "@helios/lib";
import type { LoadedSession } from "./session";
import { defaultLapConfig, lapInputsFor, loadLapConfig } from "./lap-config";
import {
  applyOverridesToStore, loadChannelOverrides, saveChannelOverrides,
} from "./channel-overrides";

const HASH_PREFIX = "user:";

/** Stable session id derived from the absolute file path. Lets lap detection
 *  config persist across app restarts (we keep the localStorage key) and
 *  prevents collisions when two files share a basename. */
export function userSessionIdFor(absPath: string): string {
  let h = 5381;
  for (let i = 0; i < absPath.length; i++) {
    h = ((h << 5) + h + absPath.charCodeAt(i)) | 0;
  }
  return `${HASH_PREFIX}${(h >>> 0).toString(16)}`;
}

/** Filename without the trailing extension, used as the human-readable
 *  session label. Strips path separators on either OS convention. */
export function labelFromPath(absPath: string): string {
  const segments = absPath.split(/[\\/]/).filter(Boolean);
  const file = segments[segments.length - 1] ?? absPath;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

export async function loadUserSession(absPath: string, color: string): Promise<LoadedSession> {
  const store = new ChannelStore();
  const yaml = await resolveResource("channels.yaml");
  await loadCsvIntoStore(store, absPath, yaml);
  const id = userSessionIdFor(absPath);
  // Apply any saved channel overrides BEFORE building lap config /
  // computing laps — lapConfig's defaults pick speed/gps channels by id,
  // and the user may have overridden which physical column those ids point
  // at. Stale targets (header gone after a fresh CSV export) are dropped.
  const savedOverrides = loadChannelOverrides(id);
  const channelOverrides = applyOverridesToStore(store, savedOverrides);
  if (
    Object.keys(channelOverrides).length !== Object.keys(savedOverrides).length
  ) {
    // Re-save the cleaned set so dead entries don't accumulate forever.
    saveChannelOverrides(id, channelOverrides);
  }
  const cfg = loadLapConfig(id) ?? defaultLapConfig(store);
  const laps = cfg.mode === "none" ? null : detectLaps(cfg, lapInputsFor(store));
  return {
    id,
    label: labelFromPath(absPath),
    store,
    color,
    visible: true,
    lapConfig: cfg,
    laps,
    channelOverrides,
    sourcePath: absPath,
  };
}

/** Filter a list of dropped/picked paths to those Helios can attempt to load.
 *  CSV-only for now; Link `.llgx` and MoTeC `.ld` are recognised so the user
 *  can be told they aren't supported yet rather than silently ignored. */
export interface AcceptedPath { path: string; kind: "csv"; }
export interface RejectedPath { path: string; reason: string; }

export function classifyPaths(paths: string[]): { accepted: AcceptedPath[]; rejected: RejectedPath[] } {
  const accepted: AcceptedPath[] = [];
  const rejected: RejectedPath[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower.endsWith(".csv")) accepted.push({ path: p, kind: "csv" });
    else if (lower.endsWith(".llgx") || lower.endsWith(".llg")) rejected.push({ path: p, reason: "Link binary log (.llgx) — export to CSV from PCLink first" });
    else if (lower.endsWith(".ld") || lower.endsWith(".ldx")) rejected.push({ path: p, reason: "MoTeC binary log (.ld/.ldx) — export to CSV from i2 first" });
    else if (lower.endsWith(".helios")) rejected.push({ path: p, reason: "Helios workspace bundle — drag to import workspaces, not data" });
    else rejected.push({ path: p, reason: `unsupported extension; accepted: .csv` });
  }
  return { accepted, rejected };
}
