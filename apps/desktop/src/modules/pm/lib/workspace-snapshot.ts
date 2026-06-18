import type { Workspace } from "./data";

/**
 * Persist the last-loaded PM workspace so a cold launch can paint instantly from
 * cache and revalidate in the background (stale-while-revalidate), instead of
 * blocking on loadWorkspace's ~15 reads before showing anything.
 *
 * Pure serialize/deserialize (type-only Workspace import → no runtime deps, so
 * it's unit-testable under the env constraint) + thin localStorage wrappers.
 * Namespaced by user id so a different account never reads another's cache.
 */

// Bump whenever the cached ProjectData/Workspace shape gains or drops a field, so
// stale snapshots from an older app version are rejected and refetched instead of
// hydrating a record that's missing a field. v2: added `links` (task hyperlinks,
// 4.4.3) — a v1 snapshot has no `links`, which crashed hydration before loadFlat
// was made null-safe.
const SNAPSHOT_VERSION = 2;
// localStorage is ~5-10 MB; cap well under that. An oversize workspace simply
// isn't cached (revalidate still works) rather than throwing a quota error.
const MAX_BYTES = 3_000_000;

interface PersistedSnapshot {
  version: number;
  savedAt: string;
  userId: string;
  workspace: Workspace;
}

export function snapshotKey(userId: string): string {
  return `helios:pm:workspaceSnapshot:${userId}`;
}

/** Serialize a snapshot, or null if it can't be stringified or exceeds the cap. */
export function serializeSnapshot(ws: Workspace, userId: string, savedAt: string): string | null {
  const payload: PersistedSnapshot = { version: SNAPSHOT_VERSION, savedAt, userId, workspace: ws };
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (json.length > MAX_BYTES) return null;
  return json;
}

/** Parse a snapshot, or null on corruption / version or user mismatch / missing
 *  required fields. Never throws. */
export function deserializeSnapshot(raw: string | null, userId: string): Workspace | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<PersistedSnapshot>;
  if (p.version !== SNAPSHOT_VERSION) return null;
  if (p.userId !== userId) return null;
  const ws = p.workspace;
  if (!ws || !Array.isArray(ws.projects) || typeof ws.projectData !== "object" || ws.projectData === null) {
    return null;
  }
  return ws as Workspace;
}

export function loadSnapshot(userId: string): Workspace | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return deserializeSnapshot(localStorage.getItem(snapshotKey(userId)), userId);
  } catch {
    return null;
  }
}

export function saveSnapshot(ws: Workspace, userId: string, savedAt: string): void {
  if (typeof localStorage === "undefined") return;
  const json = serializeSnapshot(ws, userId, savedAt);
  if (!json) return;
  try {
    localStorage.setItem(snapshotKey(userId), json);
  } catch {
    // quota / private mode — caching is best-effort.
  }
}

export function clearSnapshot(userId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(snapshotKey(userId));
  } catch {
    // ignore
  }
}
