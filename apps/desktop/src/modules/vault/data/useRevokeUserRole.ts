import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId } from "./types";
import { friendlyPgError } from "./pg-errors";

/** Remove a user's role entirely (back to no vault access) via
 *  `pdm_revoke_user_role`. Server-side auth: only the owner may revoke an
 *  admin; any admin may revoke editor/viewer; the owner row can't be revoked. */
export function useRevokeUserRole() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Guard post-await setState against unmount (see useSetUserRole).
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
      const { error: err } = await client.rpc("pdm_revoke_user_role", {
        p_target: target,
      });
      // Return the result directly so callers get the real server message
      // instead of reading a stale captured `.error` after the await.
      if (err) {
        const e = new Error(friendlyPgError(err, "role").message);
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
