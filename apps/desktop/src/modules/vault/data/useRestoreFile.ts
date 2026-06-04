import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

/** Restore a soft-deleted file via pdm_restore_file (clears deleted_at). Inverse
 *  of useDeleteFile. Authorization (only the deleter or a vault admin) is
 *  enforced server-side in the SECURITY DEFINER function. */
export function useRestoreFile() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async (file_id: FileId): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const { error: err } = await client.rpc("pdm_restore_file", { p_file_id: file_id });
    setLoading(false);
    if (err) {
      setError(new Error(friendlyPgError(err, "file").message));
      return false;
    }
    // Restoring brings the file (and its history) back; lock state is unchanged
    // (delete released it), but broadcast so lock views refresh promptly.
    notifyLockChange();
    return true;
  }, [client]);

  return { run, loading, error };
}
