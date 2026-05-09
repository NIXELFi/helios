import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { LockId } from "./types";

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
        setError(new Error(err.message ?? String(err)));
        return false;
      }
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
