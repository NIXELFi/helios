import { useSyncExternalStore } from "react";
import type { AutoSyncStatus } from "../modules/vault/data/useAutoSync";

/**
 * App-wide mirror of the Vault auto-sync status.
 *
 * useAutoSync lives inside the Vault's BrowseScreen, which stays mounted
 * (hidden) when the user switches modules — so a sync keeps running after
 * they click off the Vault, but its toolbar pill goes with it. The hook
 * publishes every status change here; the shell's SyncStatusChip subscribes
 * so the title bar can show progress from any module. `null` means no sync
 * hook is mounted (Vault not opened yet, or torn down).
 *
 * Deliberately tiny and framework-free (module-level store +
 * useSyncExternalStore) so the shell doesn't have to import the Vault chunk.
 */
type Listener = () => void;

let current: AutoSyncStatus | null = null;
const listeners = new Set<Listener>();

export function publishVaultSyncStatus(status: AutoSyncStatus | null): void {
  if (status === current) return;
  current = status;
  for (const l of listeners) l();
}

export function getVaultSyncStatus(): AutoSyncStatus | null {
  return current;
}

export function subscribeVaultSyncStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop the published status and every listener. */
export function _resetVaultSyncStatus(): void {
  current = null;
  listeners.clear();
}

export function useVaultSyncStatus(): AutoSyncStatus | null {
  return useSyncExternalStore(subscribeVaultSyncStatus, getVaultSyncStatus, getVaultSyncStatus);
}
