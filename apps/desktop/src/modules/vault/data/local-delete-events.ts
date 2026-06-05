/**
 * Module-level event bus for local-deletion outcomes detected by useAutoSync's
 * third partition bucket (spec 2c). Mirrors the tiny pub/sub shape of
 * lock-events.ts — a Set of listeners, a subscribe that returns an unsubscribe,
 * and a notify that fans out.
 *
 * Two distinct events:
 *  - "blocked": a file the user deleted locally but wasn't checked out. The
 *    sync pass re-downloads (restores) it and fires this so the UI can warn
 *    "check out first to delete" (in-app banner + OS notification).
 *  - "propagated": a file the user deleted locally while checked out to them.
 *    The sync pass soft-deletes it in the vault and fires this so the UI can
 *    surface a "moved to Deleted" confirmation.
 *
 * Both carry the affected file NAMES (basenames) for display. Decoupling the
 * sync pass from the warning UI this way keeps useAutoSync free of React-tree
 * concerns, exactly like lock-events decouples mutations from useLocks.
 */

type NamesListener = (names: string[]) => void;

const blockedListeners = new Set<NamesListener>();
const propagatedListeners = new Set<NamesListener>();

/** Subscribe to "deleted locally but not checked out — restored" events.
 *  Returns an unsubscribe function. */
export function onLocalDeleteBlocked(cb: NamesListener): () => void {
  blockedListeners.add(cb);
  return () => {
    blockedListeners.delete(cb);
  };
}

/** Fire a blocked-deletion event with the restored file names. No-op for an
 *  empty list (callers may still call it unconditionally). */
export function notifyLocalDeleteBlocked(names: string[]): void {
  if (names.length === 0) return;
  for (const cb of blockedListeners) cb(names);
}

/** Subscribe to "deleted locally while checked out — propagated to Deleted"
 *  events. Returns an unsubscribe function. */
export function onLocalDeletesPropagated(cb: NamesListener): () => void {
  propagatedListeners.add(cb);
  return () => {
    propagatedListeners.delete(cb);
  };
}

/** Fire a propagated-deletion event with the soft-deleted file names. No-op for
 *  an empty list. */
export function notifyLocalDeletesPropagated(names: string[]): void {
  if (names.length === 0) return;
  for (const cb of propagatedListeners) cb(names);
}
