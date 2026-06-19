/**
 * Pure notification library for the Vault file-watch feature.
 *
 * v1 LIMITATION: Notifications are frontend-only, persisted in localStorage.
 * They are derived from the realtime Supabase stream the app already subscribes
 * to and are only visible in the current browser/device session. Cross-device
 * delivery and offline history require a server-side `pdm.notifications` table
 * with an insert trigger / DB function that fans out events to watched files per
 * user. That is an explicit follow-up and out of scope for v1.
 *
 * Design rules for this file:
 *  - NO Date.now() / new Date() calls — timestamps are passed in from callers
 *    (hooks) so this module stays pure and trivially testable.
 *  - NO React, NO Supabase — pure TypeScript only.
 *  - NO localStorage access — callers (hooks) handle persistence.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationKind =
  | "checked_in"
  | "checked_out"
  | "unlocked"
  | "force_unlocked"
  | "deleted"
  | "restored";

export interface Notification {
  /** Stable, deterministic id derived from the event so duplicates can be
   *  de-duped without a random uuid generator (pure fn friendly). */
  id: string;
  fileId: string;
  kind: NotificationKind;
  fileName: string;
  actorId: string | null;
  /** ISO timestamp — stamped by the hook (where Date is allowed), not here. */
  at: string;
  read: boolean;
}

/**
 * The shape of a Supabase postgres_changes payload as seen by useVaultRealtime
 * callbacks. Typed loosely (unknown row shapes) so this module doesn't need to
 * import the full DB row types — callers cast before passing.
 */
export interface RealtimePayload {
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

/**
 * Context the caller provides so we can resolve file names without coupling
 * this module to useFiles / React Query state.
 */
export interface NotificationCtx {
  /** Maps fileId → display name (populated from whatever the caller has in
   *  memory — the files query result). Falls back to fileId when absent. */
  fileNames: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build a deterministic notification id from its key fields so that
 * replaying the same event twice de-dupes cleanly.
 */
function makeId(table: string, eventType: string, rowId: string, at: string): string {
  return `${table}:${eventType}:${rowId}:${at}`;
}

// ---------------------------------------------------------------------------
// eventToNotification
// ---------------------------------------------------------------------------

/**
 * Map a single realtime change event to a Notification if (and only if) the
 * affected file is in `watchedFileIds`. Returns null for any event that is:
 *  - not about a watched file
 *  - not a recognizable notification-worthy change
 *  - malformed / missing required fields
 *
 * @param payload  - the raw Supabase postgres_changes payload
 * @param watchedFileIds - the current watch set for this vault
 * @param ctx      - resolver context (file names)
 * @param at       - ISO timestamp to stamp on the notification (caller-supplied)
 */
export function eventToNotification(
  payload: RealtimePayload,
  watchedFileIds: Set<string>,
  ctx: NotificationCtx,
  at: string,
): Notification | null {
  // Defensive: guard null/undefined payload (callers may be untyped)
  if (!payload || typeof payload !== "object") return null;

  const { table, eventType, new: newRow, old: oldRow } = payload;

  // -------------------------------------------------------------------------
  // versions INSERT → checked_in
  // -------------------------------------------------------------------------
  if (table === "versions" && eventType === "INSERT") {
    if (!newRow) return null;
    const fileId = str(newRow.file_id);
    if (!fileId || !watchedFileIds.has(fileId)) return null;
    const rowId = str(newRow.id) ?? "?";
    const actorId = str(newRow.author_id);
    const fileName = ctx.fileNames.get(fileId) ?? fileId;
    return {
      id: makeId(table, eventType, rowId, at),
      fileId,
      kind: "checked_in",
      fileName,
      actorId,
      at,
      read: false,
    };
  }

  // -------------------------------------------------------------------------
  // locks INSERT → checked_out
  // -------------------------------------------------------------------------
  if (table === "locks" && eventType === "INSERT") {
    if (!newRow) return null;
    const fileId = str(newRow.file_id);
    if (!fileId || !watchedFileIds.has(fileId)) return null;
    const rowId = str(newRow.id) ?? "?";
    const actorId = str(newRow.user_id);
    const fileName = ctx.fileNames.get(fileId) ?? fileId;
    return {
      id: makeId(table, eventType, rowId, at),
      fileId,
      kind: "checked_out",
      fileName,
      actorId,
      at,
      read: false,
    };
  }

  // -------------------------------------------------------------------------
  // locks UPDATE → unlocked OR force_unlocked
  //   force_unlocked wins: if force_released_by just appeared, that's the story.
  // -------------------------------------------------------------------------
  if (table === "locks" && eventType === "UPDATE") {
    if (!newRow) return null;
    const fileId = str(newRow.file_id);
    if (!fileId || !watchedFileIds.has(fileId)) return null;

    const newForce = str(newRow.force_released_by);
    const oldForce = str(oldRow?.force_released_by ?? null);
    const newReleasedAt = str(newRow.released_at);
    const oldReleasedAt = str(oldRow?.released_at ?? null);

    let kind: NotificationKind | null = null;
    let actorId: string | null = null;

    if (newForce && newForce !== oldForce) {
      kind = "force_unlocked";
      actorId = newForce;
    } else if (newReleasedAt && !oldReleasedAt) {
      kind = "unlocked";
      actorId = str(newRow.user_id);
    }

    if (!kind) return null; // nothing notification-worthy changed

    const rowId = str(newRow.id) ?? "?";
    const fileName = ctx.fileNames.get(fileId) ?? fileId;
    return {
      id: makeId(table, eventType + ":" + kind, rowId, at),
      fileId,
      kind,
      fileName,
      actorId,
      at,
      read: false,
    };
  }

  // -------------------------------------------------------------------------
  // files UPDATE: deleted_at toggled → deleted / restored
  // -------------------------------------------------------------------------
  if (table === "files" && eventType === "UPDATE") {
    if (!newRow) return null;
    const fileId = str(newRow.id);
    if (!fileId || !watchedFileIds.has(fileId)) return null;

    const newDeleted = newRow.deleted_at ?? null;
    const oldDeleted = oldRow?.deleted_at ?? null;

    let kind: NotificationKind | null = null;
    if (newDeleted && !oldDeleted) {
      kind = "deleted";
    } else if (!newDeleted && oldDeleted) {
      kind = "restored";
    }

    if (!kind) return null;

    const fileName = str(newRow.name) ?? ctx.fileNames.get(fileId) ?? fileId;
    return {
      id: makeId(table, eventType + ":" + kind, fileId, at),
      fileId,
      kind,
      fileName,
      actorId: null,
      at,
      read: false,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// mergeNotifications
// ---------------------------------------------------------------------------

/**
 * Prepend `incoming` items to `existing`, de-duplicate by id (incoming wins
 * if duplicate — allows re-delivery to update read state), then cap to `cap`
 * items (newest first).
 */
export function mergeNotifications(
  existing: Notification[],
  incoming: Notification[],
  cap: number,
): Notification[] {
  if (incoming.length === 0) return existing;

  const incomingIds = new Set(incoming.map((n) => n.id));
  // Prepend incoming, then filter existing to remove duplicates
  const merged = [...incoming, ...existing.filter((n) => !incomingIds.has(n.id))];
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------

/** Count notifications where read === false. */
export function unreadCount(list: Notification[]): number {
  return list.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}
