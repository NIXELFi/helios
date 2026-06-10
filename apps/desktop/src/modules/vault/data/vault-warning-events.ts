/**
 * Module-level event bus for non-fatal vault warnings that outlive the
 * component that detected them (e.g. CheckInButton unmounts the moment a
 * check-in succeeds, but its reference/property warnings still need a surface).
 * Same tiny pub/sub shape as local-delete-events.ts; VaultWarningBanner is the
 * single subscriber/renderer.
 */

export interface VaultWarning {
  title: string;
  detail: string;
}

type Listener = (w: VaultWarning) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns an unsubscribe function. */
export function onVaultWarning(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyVaultWarning(w: VaultWarning): void {
  for (const cb of listeners) cb(w);
}
