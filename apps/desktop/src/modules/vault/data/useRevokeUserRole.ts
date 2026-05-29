import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId } from "./types";

/** Remove a user's role entirely (back to no vault access) via
 *  `pdm_revoke_user_role`. Server-side auth: only the owner may revoke an
 *  admin; any admin may revoke editor/viewer; the owner row can't be revoked. */
export function useRevokeUserRole() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (target: UserId): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_revoke_user_role", {
        p_target: target,
      });
      setLoading(false);
      if (err) {
        setError(new Error(String(err.message ?? err)));
        return false;
      }
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
