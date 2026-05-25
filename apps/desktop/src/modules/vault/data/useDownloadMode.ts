import { useCallback, useEffect, useState } from "react";
import type { VaultId } from "./types";

const STORAGE_KEY = "helios.vault.downloadMode";

export type DownloadMode = "auto" | "manual";

// Per-vault setting. JSON map { [vaultId]: 'auto' | 'manual' } in localStorage.
// Default for any unset vault is 'auto' (today's behavior). 'manual' keeps the
// file listing live but suppresses background blob downloads — the user
// clicks "Download" per row when they want bytes on disk.
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
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const mode: DownloadMode = vaultId ? (map[vaultId] ?? "auto") : "auto";

  const setMode = useCallback((next: DownloadMode) => {
    if (!vaultId) return;
    setMap((prev) => {
      const updated: Map = { ...prev, [vaultId]: next };
      writeMap(updated);
      return updated;
    });
  }, [vaultId]);

  return { mode, setMode };
}
