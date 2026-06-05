import { useEffect, useRef } from "react";
import { remove } from "@tauri-apps/plugin-fs";
import type { Folder, VaultFile } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { vaultRelativePath, normalizePathForCompare } from "./local-match";
import { setReadonly } from "./fs-readonly";
import { ledgerRemove } from "./sync-ledger";
import { folderPath } from "./folder-paths";

/**
 * Reaper: removes the LOCAL working copy of soft-deleted vault files on this
 * machine. When a file is soft-deleted (deleted_at set) it leaves the browse
 * list; this deletes its on-disk copy so a delete propagates to everyone's
 * machine. The DB row and every version survive, so restoring it (which clears
 * deleted_at) drops it back into the normal vault list and auto-sync
 * re-downloads it.
 *
 * Also removes the local directory of each vault-deleted FOLDER (non-recursive
 * — a dir still containing untracked files fails safely and is skipped,
 * preserving any data the vault doesn't own). Folders are attempted
 * deepest-first so children are removed before parents.
 *
 * Deliberately SEPARATE from useAutoSync's download / generation / abort
 * machinery: this only ever REMOVES files, never downloads, so it needs none of
 * that race choreography. It can only ever target a deleted file's OWN local
 * copy because it matches with the exact same `vaultRelativePath` +
 * `normalizePathForCompare` the rest of the vault uses (no path guessing).
 * Best-effort: a failed remove (file open elsewhere / permission / already
 * gone) is simply retried on the next pass and never throws.
 *
 * Gated on `enabled` (auto-sync / download mode) so it only runs when the app is
 * the one managing the local working copy — in manual mode the user owns their
 * files and we never delete them out from under them.
 */
export function useDeletedFileReaper(input: {
  enabled: boolean;
  deletedFiles: VaultFile[] | null | undefined;
  localFiles: LocalFile[] | null;
  folders: Folder[];
  /** Soft-deleted folders whose local directories should be reaped. Uses a
   *  combined lookup set of live + deleted folders so a deleted child under a
   *  live parent can still resolve its path. */
  deletedFolders?: Folder[] | null | undefined;
  /** Absolute vault root path — required for folder-dir reaping; ignored when
   *  null/undefined. */
  vaultRoot?: string | null;
  /** Active vault id — when set, each successful local removal also drops the
   *  file's sync-ledger entry so a re-download (after restore) re-stamps it
   *  fresh rather than instantly looking "locally-deleted". Null disables it. */
  vaultId?: string | null;
  /** Called after at least one local copy was removed (e.g. to trigger a
   *  local rescan so the removed files leave the scan promptly). */
  onReaped?: () => void;
}): void {
  const { enabled, deletedFiles, localFiles, folders, deletedFolders, vaultRoot, vaultId, onReaped } = input;

  // Keep the callback in a ref so a fresh identity each render doesn't re-fire
  // the reap effect.
  const onReapedRef = useRef(onReaped);
  useEffect(() => {
    onReapedRef.current = onReaped;
  }, [onReaped]);

  useEffect(() => {
    if (!enabled) return;
    // Vault-switch race guard (mirrors useAutoSync): on an active-vault change
    // the local-path inputs update before the row queries refetch, so vault
    // A's deleted rows could transiently pair with vault B's local scan. Only
    // reap once every row belongs to the active vault.
    if (
      vaultId &&
      ((deletedFiles ?? []).some((f) => f.vault_id !== vaultId) ||
        (deletedFolders ?? []).some((f) => f.vault_id !== vaultId) ||
        folders.some((f) => f.vault_id !== vaultId))
    ) {
      return;
    }
    // Proceed even if deletedFiles is empty when there are deleted folders to
    // reap — the file-reap loop is gated on its own early-exit below.
    const hasDeletedFiles = deletedFiles && deletedFiles.length > 0;
    const hasDeletedFolders = deletedFolders && deletedFolders.length > 0 && vaultRoot;
    if (!hasDeletedFiles && !hasDeletedFolders) return;
    if (!localFiles) return;

    // Index local files by their normalized relative path — the SAME key the
    // rest of the vault uses to match a DB file row to a file on disk, so a
    // deleted file can only ever resolve to its own copy.
    const localByRel = new Map<string, LocalFile>();
    for (const l of localFiles) {
      localByRel.set(normalizePathForCompare(l.relativePath), l);
    }

    let cancelled = false;
    (async () => {
      let removedAny = false;

      // ── File reap ──────────────────────────────────────────────────────────
      if (hasDeletedFiles && localFiles.length > 0) {
        for (const f of deletedFiles!) {
          if (cancelled) return;
          const rel = vaultRelativePath(f, folders);
          const key = normalizePathForCompare(rel);
          const local = localByRel.get(key);
          if (!local) continue; // no local copy of this deleted file → nothing to do
          try {
            // Vault working copies are kept read-only; clear the bit first or
            // remove() fails on Windows (can't delete a read-only file).
            await setReadonly(local.absolutePath, false);
            await remove(local.absolutePath);
            removedAny = true;
            // Drop the ledger entry: this local copy is gone because the VAULT
            // deleted the file, not the user. Removing it means a later restore +
            // re-download re-stamps a fresh entry (the worker's ledgerRecord),
            // rather than the file looking "locally-deleted" the instant it
            // returns. Fire-and-forget; best-effort like all ledger IO.
            if (vaultId) void ledgerRemove(vaultId, rel);
          } catch (e) {
            console.warn(`[vault] reaper: couldn't remove ${local.absolutePath}:`, e);
          }
        }
      }

      // ── Folder-dir reap ────────────────────────────────────────────────────
      // For each vault-deleted folder, attempt to remove the corresponding
      // local directory. Non-recursive on purpose: if the dir still contains
      // untracked files (or any files at all) the remove() call fails and we
      // skip it — we NEVER delete data the vault doesn't own.
      //
      // Path resolution uses a combined lookup (live + deleted) so a deleted
      // child under a still-live parent can resolve its full path correctly.
      if (hasDeletedFolders && vaultRoot) {
        // Build the combined lookup set once: live folders + deleted folders.
        const lookupSet: Folder[] = [...(folders ?? []), ...(deletedFolders ?? [])];

        // Sort deepest-first (most path segments first) so child dirs are
        // attempted before their parents, giving the parent the best chance
        // of being empty by the time we reach it.
        const sorted = [...deletedFolders!].sort((a, b) => {
          const pa = folderPath(a.id, lookupSet);
          const pb = folderPath(b.id, lookupSet);
          const depthA = pa ? pa.split("/").length : 0;
          const depthB = pb ? pb.split("/").length : 0;
          return depthB - depthA;
        });

        for (const folder of sorted) {
          if (cancelled) return;
          const rel = folderPath(folder.id, lookupSet);
          if (!rel) continue; // root or unresolvable — skip
          const absPath = `${vaultRoot}/${rel}`;
          try {
            // recursive: false — fails safely if the dir is non-empty, which
            // is exactly the desired behaviour (never delete untracked data).
            await remove(absPath, { recursive: false });
            removedAny = true;
          } catch {
            // Non-empty dir, already gone, or permission failure — fine;
            // next pass will retry when/if the dir eventually empties.
          }
        }
      }

      if (removedAny && !cancelled) onReapedRef.current?.();
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, deletedFiles, localFiles, folders, deletedFolders, vaultRoot, vaultId]);
}
