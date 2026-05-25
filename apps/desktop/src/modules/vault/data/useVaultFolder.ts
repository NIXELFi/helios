import { useCallback, useEffect, useState } from "react";
import type { VaultId } from "./types";

const STORAGE_KEY = "helios.vault.localFolder";

// The stored value is a JSON object: { [vaultId]: path }. Each vault gets
// its own working directory so SDM26 and SDM27 can sync to different folders.
//
// Legacy: prior versions stored a bare string here (one global folder). On
// first read with a known vaultId, we migrate that string under that vault's
// id so existing users don't lose their working directory.
type Map = Record<string, string>;

function parse(raw: string | null, migrationVaultId: VaultId | null): Map {
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Map;
    } catch { /* fall through */ }
  }
  // Legacy bare-string. Adopt into the currently active vault, if known.
  if (migrationVaultId) {
    const map: Map = { [migrationVaultId]: raw };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
    return map;
  }
  return {};
}

function readMap(migrationVaultId: VaultId | null): Map {
  try { return parse(localStorage.getItem(STORAGE_KEY), migrationVaultId); }
  catch { return {}; }
}

function writeMap(map: Map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function useVaultFolder(vaultId: VaultId | null): {
  path: string | null;
  setPath: (next: string | null) => void;
  clear: () => void;
} {
  const [map, setMap] = useState<Map>(() => readMap(vaultId));

  // If vaultId changes after mount, re-read (and re-attempt legacy migration).
  useEffect(() => {
    setMap(readMap(vaultId));
  }, [vaultId]);

  // Cross-window sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setMap(parse(e.newValue, vaultId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [vaultId]);

  const path = vaultId ? map[vaultId] ?? null : null;

  const setPath = useCallback((next: string | null) => {
    if (!vaultId) return;
    setMap((prev) => {
      const updated: Map = { ...prev };
      if (next === null) delete updated[vaultId];
      else updated[vaultId] = next;
      writeMap(updated);
      return updated;
    });
  }, [vaultId]);

  const clear = useCallback(() => setPath(null), [setPath]);

  return { path, setPath, clear };
}
