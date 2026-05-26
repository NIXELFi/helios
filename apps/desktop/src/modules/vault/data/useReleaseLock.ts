import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

export function useReleaseLock() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (file_id: FileId): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_cancel_checkout", {
        p_file_id: file_id,
      });
      setLoading(false);
      if (err) {
        setError(new Error(friendlyPgError(err, "lock").message));
        return false;
      }
      // Broadcast so every mounted useLocks() refetches immediately rather
      // than waiting on the realtime channel.
      notifyLockChange();
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
