import type { VaultFile, Version, VaultId } from "./types";

/**
 * Incremental apply of Supabase realtime change events to the in-memory vault
 * file lists — so a teammate's edit shows up in the next React commit instead of
 * waiting for a full vault re-pull (refetchAllFiles). The publication has FULL
 * replica identity, so payloads carry the full new row (INSERT/UPDATE) and the
 * old row (UPDATE/DELETE).
 *
 * Pure + dependency-free (mirrors vault-cursor.ts) so it is unit-testable under
 * the env constraint. The caller (BrowseScreen) falls back to a refetch on the
 * REFETCH sentinel, and the useVaultCursor count-signature poll self-heals any
 * silent drift as a backstop.
 */

export const REFETCH = "REFETCH" as const;
export type RefetchSignal = typeof REFETCH;

/** The shape of a supabase-js postgres_changes payload (the subset we use). */
export interface RowEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T | null;
  old: Partial<T> | null;
}

/**
 * Upsert/remove a file row in ONE list according to a membership predicate that
 * mirrors that list's query WHERE clause (live / per-folder / recycle-bin).
 * Returns the same array reference on a no-op (so React.memo can bail), a new
 * array on a change, or REFETCH when the payload can't be applied safely.
 */
export function applyFileEvent(
  files: VaultFile[],
  event: RowEvent<VaultFile>,
  opts: { vaultId: VaultId; belongs: (f: VaultFile) => boolean },
): VaultFile[] | RefetchSignal {
  if (event.eventType === "DELETE") {
    const id = event.old?.id;
    if (!id) return REFETCH; // replica identity didn't give us the row → reconcile
    return files.some((f) => f.id === id) ? files.filter((f) => f.id !== id) : files;
  }

  const row = event.new;
  if (!row || !row.id) return REFETCH;
  // files RLS is NOT vault-scoped, so a payload from another vault can arrive on
  // a shared channel — it never belongs in THIS vault's list, so ignore it.
  if (row.vault_id !== opts.vaultId) return files;

  const i = files.findIndex((f) => f.id === row.id);
  // A files UPDATE/INSERT payload has no embedded `latest` (that's a join), so
  // carry the existing embed forward; applyVersionEvent maintains it on check-in.
  const merged: VaultFile =
    i !== -1
      ? { ...files[i], ...row, latest: files[i]!.latest ?? row.latest ?? null }
      : { ...row, latest: row.latest ?? null };

  if (opts.belongs(merged)) {
    if (i !== -1) {
      const next = files.slice();
      next[i] = merged;
      return next;
    }
    return [...files, merged];
  }
  // Doesn't belong in this list anymore (moved out / soft-deleted / restored
  // away). Drop it if present, else no-op.
  return i !== -1 ? files.filter((f) => f.id !== row.id) : files;
}

/**
 * Patch a file's embedded latest-version from a versions INSERT (a check-in), so
 * the new version/sha shows with zero round trips. Monotonic on version_num so a
 * duplicate, reordered, or own-echoed event is a safe no-op.
 */
export function applyVersionEvent(files: VaultFile[], event: RowEvent<Version>): VaultFile[] {
  if (event.eventType !== "INSERT" || !event.new) return files;
  const v = event.new;
  const i = files.findIndex((f) => f.id === v.file_id);
  if (i === -1) return files; // file not in this list → nothing to patch
  const cur = files[i]!.latest;
  if (cur && cur.version_num >= v.version_num) return files; // older/equal → no-op
  const { properties: _omit, ...embed } = v; // EmbeddedLatest = Version minus properties
  const next = files.slice();
  next[i] = { ...files[i]!, latest_version_id: v.id, latest: embed };
  return next;
}
