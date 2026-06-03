import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId } from "./types";
import { friendlyPgError } from "./pg-errors";

/** Edit a user's profile (display name + subteam) via `pdm_admin_update_user`.
 *  Admin-gated server-side; writes auth.users metadata. Email is deliberately
 *  not editable (it's the login identity). Returns the result directly so
 *  callers get the real server message instead of a stale captured `.error`. */
export function useUpdateUser() {
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
    async (
      target: UserId,
      displayName: string | null,
      subteam: string | null,
    ): Promise<{ ok: boolean; error: Error | null }> => {
      if (mounted.current) {
        setLoading(true);
        setError(null);
      }
      const { error: err } = await client.rpc("pdm_admin_update_user", {
        p_target: target,
        p_display_name: displayName,
        p_subteam: subteam,
      });
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
