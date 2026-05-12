/* Per-session channel-override storage.
 *
 * Mirrors lap-config.ts: a localStorage key keyed by session id holds a
 * Record<canonicalId, sourceHeader>. The bundled samples have stable
 * filename-derived ids and user-loaded files get hashed-from-abspath ids,
 * so overrides persist across app restarts even though LoadedSession objects
 * themselves are recreated each launch.
 *
 * Why localStorage instead of the workspace bundle: workspace bundles are
 * pure tile layouts and are deliberately session-independent — a workspace
 * exported from session A and imported by user B doesn't carry A's data.
 * Channel overrides are per-data-file (different vehicle CSVs need different
 * fixes), so they belong with the session's other per-session settings
 * (lap-config), not with the visual layout.
 */

import type { ChannelStore } from "@helios/store";

const STORAGE_KEY = "helios.channel-overrides.v1";

interface StoredState {
  version: 1;
  bySession: Record<string, Record<string, string>>;
}

export type ChannelOverrides = Record<string, string>;

export function loadAllChannelOverrides(): Record<string, ChannelOverrides> {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.version === 1 && parsed.bySession) return parsed.bySession;
  } catch { /* ignore */ }
  return {};
}

export function saveChannelOverrides(sessionId: string, overrides: ChannelOverrides): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllChannelOverrides();
  if (Object.keys(overrides).length === 0) {
    delete all[sessionId];
  } else {
    all[sessionId] = { ...overrides };
  }
  const state: StoredState = { version: 1, bySession: all };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadChannelOverrides(sessionId: string): ChannelOverrides {
  return loadAllChannelOverrides()[sessionId] ?? {};
}

/** Seed a ChannelStore from a saved overrides map. Bad targets (the saved
 *  source_header no longer exists in this store — the user re-exported the
 *  CSV without that column, or renamed a header) are silently dropped, and
 *  the cleaned set is returned so the caller can re-save without the dead
 *  entries. */
export function applyOverridesToStore(
  store: ChannelStore,
  overrides: ChannelOverrides,
): ChannelOverrides {
  const validHeaders = new Set(
    store.listSourceHeaders().map((h) => h.sourceHeader),
  );
  const cleaned: ChannelOverrides = {};
  for (const [canonicalId, sourceHeader] of Object.entries(overrides)) {
    if (!validHeaders.has(sourceHeader)) continue;
    try {
      store.setChannelOverride(canonicalId, sourceHeader);
      cleaned[canonicalId] = sourceHeader;
    } catch {
      // setChannelOverride rejects unknown source_headers — already filtered
      // above, but keep the try/catch as belt-and-braces for future changes
      // to the validation rules.
    }
  }
  return cleaned;
}
