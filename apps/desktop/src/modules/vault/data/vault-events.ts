import type { VaultId } from "./types";

/**
 * A tiny in-process fan-out bus for the vault's realtime payloads.
 *
 * Before this existed, every consumer that wanted `postgres_changes` opened its
 * OWN Supabase channel: BrowseScreen (useVaultRealtime) and the notification
 * feed (useNotifications) each held one, so a single user with the Vault open
 * cost two realtime subscriptions on the same four tables — confirmed live in
 * prod on 2026-09-09 (2 vault users → 4 subscriptions on files/locks/versions).
 *
 * Now ONE feed (useVaultRealtimeFeed, mounted once in VaultHome) owns the
 * channel and publishes each payload here; everything else subscribes to the
 * bus. The bus is deliberately independent of the channel, so a subscriber that
 * mounts before the feed has joined the topic is fine — it simply receives
 * nothing until the first event arrives, exactly as a direct subscriber would.
 *
 * Pure and dependency-free (no React, no Supabase) so it is unit-testable.
 */

/** The pdm tables the vault feed forwards. */
export type VaultEventTable = "versions" | "locks" | "files" | "folders";

/** Receives every event for the vault it subscribed to. The payload is the raw
 *  supabase-js `postgres_changes` object, typed as `unknown` so this module
 *  stays dependency-light; callers cast to `RowEvent<…>` from apply-events. */
export type VaultEventHandler = (table: VaultEventTable, payload: unknown) => void;

const subscribers = new Map<VaultId, Set<VaultEventHandler>>();

/**
 * Listen to every realtime event for `vaultId`. Returns an unsubscribe function
 * that is safe to call more than once.
 */
export function subscribeVaultEvents(vaultId: VaultId, handler: VaultEventHandler): () => void {
  let set = subscribers.get(vaultId);
  if (!set) {
    set = new Set();
    subscribers.set(vaultId, set);
  }
  set.add(handler);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const s = subscribers.get(vaultId);
    if (!s) return;
    s.delete(handler);
    // Drop the empty bucket so switching between many vaults in one session
    // doesn't leave a growing map of empty sets behind.
    if (s.size === 0) subscribers.delete(vaultId);
  };
}

/**
 * Deliver one event to every subscriber of `vaultId`. Handlers are copied
 * before iterating so a handler that unsubscribes (or subscribes) while being
 * called can't corrupt the walk, and a handler that throws is logged and
 * skipped rather than silencing the ones behind it.
 */
export function publishVaultEvent(vaultId: VaultId, table: VaultEventTable, payload: unknown): void {
  const set = subscribers.get(vaultId);
  if (!set || set.size === 0) return;
  for (const handler of Array.from(set)) {
    try {
      handler(table, payload);
    } catch (err) {
      console.warn(`[vault events] subscriber threw on ${table}`, err);
    }
  }
}

/** Test/diagnostic helper: how many handlers are listening to a vault. */
export function vaultEventSubscriberCount(vaultId: VaultId): number {
  return subscribers.get(vaultId)?.size ?? 0;
}
