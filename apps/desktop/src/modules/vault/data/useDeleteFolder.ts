import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FolderId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

/** Soft-delete a folder subtree via pdm_delete_folder. The SECURITY DEFINER RPC
 *  stamps one delete_batch on the folder + its live descendant folders/files,
 *  releasing any active locks, so a later restore brings back exactly that
 *  batch. Role rules (editor for empty subtrees, admin when live files remain)
 *  are enforced server-side; its RAISE EXCEPTION copy ("contains N file(s)…")
 *  passes through verbatim as the UI message. Mirror of useDeleteFile. */
export function useDeleteFolder() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async (folder_id: FolderId): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const { error: err } = await client.rpc("pdm_delete_folder", { p_folder_id: folder_id });
    setLoading(false);
    if (err) {
      setError(new Error(friendlyPgError(err, "folder").message));
      return false;
    }
    // Deleting a subtree releases any locks on its files; broadcast so lock
    // views reconcile immediately rather than waiting on the realtime channel.
    notifyLockChange();
    return true;
  }, [client]);

  return { run, loading, error };
}
