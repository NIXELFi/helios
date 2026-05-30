import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

export function useDeleteFile() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async (file_id: FileId): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const { error: err } = await (client.from("files") as any).delete().eq("id", file_id);
    setLoading(false);
    if (err) {
      setError(new Error(friendlyPgError(err, "file").message));
      return false;
    }
    // Deleting a file removes any lock on it; broadcast so lock views
    // (WhoHasWhat) reconcile a deleted-while-locked file immediately rather
    // than waiting on the realtime channel. Mirrors useReleaseLock.
    notifyLockChange();
    return true;
  }, [client]);

  return { run, loading, error };
}
