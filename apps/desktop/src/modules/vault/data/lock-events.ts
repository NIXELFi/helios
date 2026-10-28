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

/** Quiet period that closes a burst: the trailing refetch fires this long
 *  after the LAST notification. */
export const LOCK_NOTIFY_DEBOUNCE_MS = 250;
/** Upper bound on how long a continuous burst can defer its trailing refetch. */
// 3s rather than 1s: each trailing fire supersedes the previous in-flight lock
// fetch, so a cap shorter than one full fetch on a big vault or slow link would
// keep any refetch from publishing until the burst ends.
export const LOCK_NOTIFY_MAX_WAIT_MS = 3000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending = false;
let pendingSince = 0;

function fire(): void {
  for (const cb of [...listeners]) cb();
}

function onTimer(): void {
  timer = null;
  if (!pending) return; // quiet window elapsed with nothing queued: back to idle
  pending = false;
  fire();
  // Keep the window open after a trailing fire so the next stragglers coalesce too.
  timer = setTimeout(onTimer, LOCK_NOTIFY_DEBOUNCE_MS);
}

/** Call this from a lock-mutation hook after a successful RPC. Triggers a
 *  refetch in every component currently rendering useLocks(), closing the
 *  staleness window before useVaultRealtime's event arrives.
 *
 *  Coalesced: the first call of a burst fires immediately (leading edge, so a
 *  single checkout still converges at once); further calls inside the window
 *  collapse into one trailing fire after LOCK_NOTIFY_DEBOUNCE_MS of quiet, but
 *  never later than LOCK_NOTIFY_MAX_WAIT_MS after the first deferred call. A
 *  300-file folder checkout therefore costs a couple of full lock refetches per
 *  mounted useLocks() instead of hundreds. The optimistic lock overlay
 *  (lock-overlay.ts) keeps the actor's own pills instant in the meantime. */
export function notifyLockChange(): void {
  if (timer === null) {
    fire();
    timer = setTimeout(onTimer, LOCK_NOTIFY_DEBOUNCE_MS);
    return;
  }
  const now = Date.now();
  if (!pending) {
    pending = true;
    pendingSince = now;
  }
  clearTimeout(timer);
  const left = pendingSince + LOCK_NOTIFY_MAX_WAIT_MS - now;
  if (left <= 0) {
    onTimer();
    return;
  }
  timer = setTimeout(onTimer, Math.min(LOCK_NOTIFY_DEBOUNCE_MS, left));
}

/** Test isolation: drop any queued trailing fire and return to idle. */
export function resetLockEventsForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = false;
  pendingSince = 0;
}
