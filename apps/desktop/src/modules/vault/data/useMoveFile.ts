import { useCallback, useState } from "react";
import { mkdir, rename, exists } from "@tauri-apps/plugin-fs";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, FolderId, VaultFile } from "./types";
import { friendlyPgError } from "./pg-errors";
import { localDestPath, vaultRelPathFor } from "./folder-paths";
import { ledgerRecord, ledgerRemove } from "./sync-ledger";

/**
 * Move a file to another folder (tree drag-and-drop). Two halves:
 *   1. Server: UPDATE files.folder_id. RLS allows this for VAULT ADMINS only
 *      (files_update_admin) — the UI gates the drag affordance accordingly.
 *      Opening moves to editors needs a pdm_move_file RPC (lock-holder check
 *      server-side); tracked as a follow-up migration.
 *   2. Local: if a working copy exists at the old vault-relative path, rename
 *      it to the new one (creating directories as needed) and re-record the
 *      sync ledger, so the move doesn't leave a stray local file that scans
 *      as unmatched.
 */
export function useMoveFile() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (
      file: VaultFile,
      targetFolderId: FolderId | null,
      ctx: { vaultRoot: string | null; folders: Folder[]; vaultId: string | null },
    ): Promise<boolean> => {
      if (file.folder_id === targetFolderId) return true; // no-op drop on own folder
      setLoading(true);
      setError(null);
      // Scope the UPDATE to the active vault as defence-in-depth: a global admin's
      // RLS role spans vaults, so without this a drop could re-parent a row into a
      // folder that belongs to a DIFFERENT vault. file.id alone is globally unique,
      // but the vault_id predicate makes a cross-vault re-parent structurally
      // impossible (the row simply won't match).
      let q = (client.from("files") as any)
        .update({ folder_id: targetFolderId })
        .eq("id", file.id);
      if (ctx.vaultId) q = q.eq("vault_id", ctx.vaultId);
      const { error: err } = await q;
      if (err) {
        setError(new Error(friendlyPgError(err, "file").message));
        setLoading(false);
        return false;
      }
      // Re-key the sync ledger: DROP the old vault-relative path's entry. Leaving
      // it behind makes a later move-BACK to this path look like a local deletion
      // to the auto-sync pass, which (if the user holds the lock) would call
      // pdm_delete_file and soft-delete the live vault row. The new path is
      // recorded in the local-rename block below.
      if (ctx.vaultId) {
        void ledgerRemove(ctx.vaultId, vaultRelPathFor(file.folder_id, file.name, ctx.folders));
      }
      // Best-effort local rename — a failure here must not fail the move the
      // server already accepted (auto-sync will re-materialize at the new
      // path, and the old copy surfaces as unmatched rather than data loss).
      if (ctx.vaultRoot) {
        try {
          const from = localDestPath(ctx.vaultRoot, file.folder_id, file.name, ctx.folders);
          const to = localDestPath(ctx.vaultRoot, targetFolderId, file.name, ctx.folders);
          if (from !== to && (await exists(from))) {
            const dir = to.slice(0, to.lastIndexOf("/"));
            await mkdir(dir, { recursive: true }).catch(() => { /* may exist */ });
            await rename(from, to);
            const sha = file.latest?.sha256;
            if (ctx.vaultId && sha) {
              void ledgerRecord(ctx.vaultId, vaultRelPathFor(targetFolderId, file.name, ctx.folders), sha);
            }
          }
        } catch {
          // Local copy stays at the old path — recoverable via rescan/sync.
        }
      }
      setLoading(false);
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
