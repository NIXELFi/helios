import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { LockId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

export function useForceUnlock() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (lock_id: LockId, reason: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_force_unlock", {
        p_lock_id: lock_id,
        p_reason: reason,
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
