/**
 * Small module-level event bus for lock mutations.
 *
 * Problem this solves (per the 2026-05-25 audit): useAcquireLock,
 * useReleaseLock, and useForceUnlock all mutate `pdm.locks`, but useLocks
 * doesn't know to refetch when one of them succeeds. Today the UI converges
 * only when useVaultRealtime fires an `onLock` event — which works in the
 * happy path but creates a window of stale data between the RPC settling
 * client-side and the realtime channel delivering. During that window
 * auto-sync can clobber a file the user just unlocked because useLocks
 * still shows them as the holder.
 *
 * Pattern: useLocks subscribes to changes; mutation hooks call notify()
 * after a successful RPC. Same subscriber/broadcast shape used by
 * useDownloadMode and useActiveVault.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to lock mutations. Returns an unsubscribe function. */
export function subscribeLockChanges(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Call this from a lock-mutation hook after a successful RPC. Triggers an
 *  immediate refetch in every component currently rendering useLocks(),
 *  closing the staleness window before useVaultRealtime's event arrives. */
export function notifyLockChange(): void {
  for (const cb of listeners) cb();
}
