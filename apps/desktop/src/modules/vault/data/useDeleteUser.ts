import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId } from "./types";
import { friendlyPgError } from "./pg-errors";

/** Permanently delete a user account via `pdm_admin_delete_user`. The SECURITY
 *  DEFINER function enforces the guards (not self, not owner, only the owner may
 *  delete an admin), detaches every reference, releases their locks, and removes
 *  the auth row — all in one transaction. */
export function useDeleteUser() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (target: UserId): Promise<{ ok: boolean; error: Error | null }> => {
      if (mounted.current) {
        setLoading(true);
        setError(null);
      }
      const { error: err } = await client.rpc("pdm_admin_delete_user", { p_target: target });
      if (err) {
        const e = new Error(friendlyPgError(err, "generic").message);
        if (mounted.current) {
          setError(e);
          setLoading(false);
        }
        return { ok: false, error: e };
      }
      if (mounted.current) setLoading(false);
      return { ok: true, error: null };
    },
    [client],
  );

  return { run, loading, error };
}
