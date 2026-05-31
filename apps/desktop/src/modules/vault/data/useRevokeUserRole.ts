import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId, VaultId } from "./types";
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
    async (target: UserId, vaultId?: VaultId | null): Promise<{ ok: boolean; error: Error | null }> => {
      if (mounted.current) {
        setLoading(true);
        setError(null);
      }
      // Omit p_vault_id to revoke the GLOBAL role (2-arg RPC); include it to
      // revoke a per-vault role (3-arg RPC).
      const args = vaultId ? { p_target: target, p_vault_id: vaultId } : { p_target: target };
      const { error: err } = await client.rpc("pdm_revoke_user_role", args);
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
