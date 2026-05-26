import { useCallback, useEffect, useState } from "react";
import type { VaultId } from "./types";

const STORAGE_KEY = "helios.vault.downloadMode";

export type DownloadMode = "auto" | "manual";

// Per-vault setting. JSON map { [vaultId]: 'auto' | 'manual' } in localStorage.
// Default for any unset vault is 'manual' — most users on a Mac can't open
// SolidWorks parts locally and don't want gigabytes of CAD files syncing
// behind their back. The DownloadModeWelcome modal asks the user once per
// device before any download work runs, so this default only kicks in for
// vaults the user never explicitly chose for.
type Map = Record<string, DownloadMode>;

function readMap(): Map {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Map : {};
  } catch { return {}; }
}

function writeMap(map: Map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// Same-window subscriber set. setMode in one component broadcasts to every
// useDownloadMode instance in the same window so the UI updates instantly
// without remounting. Cross-window sync still rides the storage event.
//
// A previous version dispatched a synthetic StorageEvent without newValue,
// which the listener interpreted as "key cleared" — wiping the map for
// sibling instances.
type ModeSub = (next: Map) => void;
const modeSubs = new Set<ModeSub>();
function broadcastMode(next: Map) {
  for (const s of modeSubs) s(next);
}

export function useDownloadMode(vaultId: VaultId | null): {
  mode: DownloadMode;
  setMode: (next: DownloadMode) => void;
} {
  const [map, setMap] = useState<Map>(() => readMap());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        try { setMap(e.newValue ? JSON.parse(e.newValue) : {}); }
        catch { setMap({}); }
      }
    };
    const sub: ModeSub = (next) => setMap(next);
    window.addEventListener("storage", onStorage);
    modeSubs.add(sub);
    return () => {
      window.removeEventListener("storage", onStorage);
      modeSubs.delete(sub);
    };
  }, []);

  const mode: DownloadMode = vaultId ? (map[vaultId] ?? "manual") : "manual";

  const setMode = useCallback((next: DownloadMode) => {
    if (!vaultId) return;
    // Compute the new map outside the state updater so the side effects
    // (writeMap, broadcastMode) fire exactly once even under React's
    // StrictMode double-invoke. Reading via readMap() at this moment is
    // the authoritative source — picks up cross-tab updates the local
    // `map` state may not have observed yet via the storage event.
    const updated: Map = { ...readMap(), [vaultId]: next };
    writeMap(updated);
    broadcastMode(updated);
    setMap(updated);
  }, [vaultId]);

  return { mode, setMode };
}
