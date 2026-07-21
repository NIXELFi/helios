import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, FolderId, VaultId } from "./types";
import { friendlyPgError } from "./pg-errors";

/** Shape returned by the pdm_create_folder RPC (20260721000000). */
export interface CreateFolderResult {
  folder: Folder;
  /** True when a brand-new row was inserted. */
  created: boolean;
  /** True when a recycle-bin tombstone with this name was brought back (empty —
   *  its old contents stay deleted). Distinct from `created` so callers can
   *  message it if they ever need to. */
  resurrected: boolean;
}

/** Create a folder via the pdm_create_folder RPC rather than a direct INSERT.
 *  The RPC is resurrect-or-create: a soft-deleted folder occupying the same
 *  (vault, parent, name) slot — which the unique indexes span — is revived
 *  empty instead of failing the insert with a unique-violation, which used to
 *  make a deleted folder's name unusable forever (audit M2). */
export function useCreateFolder() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (
      vault_id: VaultId,
      name: string,
      parent_id: FolderId | null = null,
    ): Promise<Folder | null> => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.rpc("pdm_create_folder", {
        p_vault_id: vault_id,
        p_parent_id: parent_id,
        p_name: name,
      });
      setLoading(false);
      if (err) {
        setError(new Error(friendlyPgError(err, "folder").message));
        return null;
      }
      return (data as CreateFolderResult).folder;
    },
    [client],
  );

  return { run, loading, error };
}
