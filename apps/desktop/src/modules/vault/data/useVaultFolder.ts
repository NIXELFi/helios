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
  // NOTE: this is a pure transform — the localStorage write that persists
  // the migration happens in useVaultFolder's useEffect, not here, so this
  // function is safe to call during render.
  if (migrationVaultId) {
    return { [migrationVaultId]: raw };
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

// True if the stored value is a legacy bare-string (i.e. not JSON-object).
function isLegacyBareString(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return !!raw && !raw.startsWith("{");
  } catch { return false; }
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

  // Persist the legacy bare-string migration. Pulled out of `parse` so that
  // render stays side-effect-free (parse is called from useState init and
  // from the [vaultId] effect's setMap). Once the stored value has been
  // upgraded to a JSON object, this effect is a no-op on subsequent runs.
  useEffect(() => {
    if (!vaultId) return;
    if (!isLegacyBareString()) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && !raw.startsWith("{")) {
        writeMap({ [vaultId]: raw });
      }
    } catch { /* ignore */ }
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
