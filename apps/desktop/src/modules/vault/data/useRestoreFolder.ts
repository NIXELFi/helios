import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FolderId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

/** Restore a soft-deleted folder via pdm_restore_folder (clears deleted_at on
 *  its whole delete_batch + re-anchors deleted ancestors). Inverse of
 *  useDeleteFolder. Authorization (only the deleter or a vault admin) is
 *  enforced server-side in the SECURITY DEFINER function. Mirror of
 *  useRestoreFile. */
export function useRestoreFolder() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async (folder_id: FolderId): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const { error: err } = await client.rpc("pdm_restore_folder", { p_folder_id: folder_id });
    setLoading(false);
    if (err) {
      setError(new Error(friendlyPgError(err, "folder").message));
      return false;
    }
    // Restoring brings the subtree (and its files) back; lock state is unchanged
    // (delete released them), but broadcast so lock views refresh promptly.
    notifyLockChange();
    return true;
  }, [client]);

  return { run, loading, error };
}
