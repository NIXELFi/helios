import { useCallback, useEffect, useMemo, useState } from "react";
import { useVaults } from "./useVaults";
import type { Vault, VaultId } from "./types";

const STORAGE_KEY = "helios.vault.activeVaultId";

function readStored(): VaultId | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeStored(id: VaultId | null) {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch { /* private mode etc. */ }
}

/**
 * Resolves which vault is "active" for the current user.
 *
 * Storage: a single string id in localStorage under helios.vault.activeVaultId.
 * Fallback: if no stored id, or the stored id is no longer in the user's
 * useVaults() result (revoked / deleted), choose the most-recently-created
 * vault and persist that choice. Empty list → activeVaultId is null and the
 * caller renders an empty state.
 *
 * Cross-window sync via the `storage` event so two desktop windows on the
 * same machine stay in step when one switches vaults.
 */
export function useActiveVault(): {
  activeVaultId: VaultId | null;
  activeVault: Vault | null;
  setActiveVaultId: (id: VaultId) => void;
  vaults: Vault[];
  loading: boolean;
  refetch: () => void;
} {
  const { data: vaults, loading, refetch } = useVaults();
  const [stored, setStored] = useState<VaultId | null>(() => readStored());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStored(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Resolution: stored id (if valid) → most-recently-created → null.
  const resolved = useMemo<VaultId | null>(() => {
    if (!vaults || vaults.length === 0) return null;
    if (stored && vaults.some((v) => v.id === stored)) return stored;
    const sorted = [...vaults].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return sorted[0]?.id ?? null;
  }, [vaults, stored]);

  // Persist a corrected choice (stored was stale or missing) once vaults load.
  useEffect(() => {
    if (resolved && resolved !== stored) {
      writeStored(resolved);
      setStored(resolved);
    }
  }, [resolved, stored]);

  const activeVault = useMemo(
    () => (vaults && resolved ? vaults.find((v) => v.id === resolved) ?? null : null),
    [vaults, resolved],
  );

  const setActiveVaultId = useCallback((id: VaultId) => {
    writeStored(id);
    setStored(id);
  }, []);

  return {
    activeVaultId: resolved,
    activeVault,
    setActiveVaultId,
    vaults: vaults ?? [],
    loading,
    refetch,
  };
}
