/**
 * Optimistic lock overlay — makes the actor's own checkout / cancel show on the
 * file's lock pill instantly, instead of waiting a round trip + realtime echo.
 *
 * A mutation hook writes an overlay entry synchronously BEFORE awaiting its RPC;
 * useLocks projects the overlay onto its canonical list on render (so the pill
 * updates this frame). On the RPC's success the existing notifyLockChange()
 * refetch lands and reconcileLockOverlay() drops the now-confirmed entry (no
 * flicker — the real row supersedes the temp one). On error the hook clears the
 * entry and the pill reverts.
 *
 * The pure projection/reconcile fns are unit-tested; the module store is a thin
 * subscriber/broadcast bus (same shape as lock-events.ts) that only triggers a
 * re-render — NOT a refetch — so an optimistic write costs zero extra network.
 */
import type { FileId, Lock } from "./types";

export type OverlayEntry = { kind: "add"; lock: Lock } | { kind: "remove" };

const overlay = new Map<FileId, OverlayEntry>();
const listeners = new Set<() => void>();

/** Subscribe to overlay changes (re-render only, no refetch). */
export function subscribeLockOverlay(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function notifyOverlay(): void {
  for (const cb of listeners) cb();
}

export function getLockOverlay(): Map<FileId, OverlayEntry> {
  return overlay;
}

export function setLockOverlay(fileId: FileId, entry: OverlayEntry): void {
  overlay.set(fileId, entry);
  notifyOverlay();
}

export function clearLockOverlay(fileId: FileId): void {
  if (overlay.delete(fileId)) notifyOverlay();
}

/** Drop ALL optimistic entries. Intended for sign-out / vault-switch (stale
 *  optimistic state from a prior session/vault shouldn't bleed across), and for
 *  test isolation (the overlay is a module singleton). */
export function resetLockOverlay(): void {
  if (overlay.size === 0) return;
  overlay.clear();
  notifyOverlay();
}

/** Drop overlay entries the canonical list now agrees with. Called from
 *  useLocks when a fresh fetch lands (which already re-renders), so it notifies
 *  only the OTHER subscribers when it actually changed something. */
export function reconcileLockOverlay(fresh: Lock[]): void {
  let changed = false;
  for (const fileId of entriesToClear(overlay, fresh)) {
    overlay.delete(fileId);
    changed = true;
  }
  if (changed) notifyOverlay();
}

/** PURE: project the optimistic overlay onto a canonical lock list. Returns the
 *  same reference when the overlay is empty (steady state → no re-render churn). */
export function applyOverlay(base: Lock[], ov: Map<FileId, OverlayEntry>): Lock[] {
  if (ov.size === 0) return base;
  const out = base.filter((l) => ov.get(l.file_id)?.kind !== "remove");
  for (const [fileId, e] of ov) {
    if (e.kind === "add" && !out.some((l) => l.file_id === fileId)) out.push(e.lock);
  }
  return out;
}

/** PURE: which overlay fileIds the canonical list now confirms (safe to drop) —
 *  an `add` whose file is held, or a `remove` whose file is no longer held. */
export function entriesToClear(ov: Map<FileId, OverlayEntry>, fresh: Lock[]): FileId[] {
  const held = new Set(fresh.filter((l) => l.released_at === null).map((l) => l.file_id));
  const clear: FileId[] = [];
  for (const [fileId, e] of ov) {
    if ((e.kind === "add" && held.has(fileId)) || (e.kind === "remove" && !held.has(fileId))) {
      clear.push(fileId);
    }
  }
  return clear;
}
