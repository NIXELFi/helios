import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId, VaultId, VaultRole } from "./types";
import { friendlyPgError } from "./pg-errors";

/** Grant or change a user's role via `pdm_set_user_role`. Authorization (only
 *  the owner may grant/change admin; any admin may grant editor/viewer) is
 *  enforced server-side inside the SECURITY DEFINER function — the client UI
 *  mirrors those rules only for affordance. 'owner' is intentionally not an
 *  accepted argument. */
export function useSetUserRole() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Guard post-await setState against unmount. A grant/revoke that resolves
  // after the AdminScreen unmounts (tab switch) would otherwise warn and
  // leak state into a dead component.
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
      role: Exclude<VaultRole, "owner">,
      vaultId?: VaultId | null,
    ): Promise<{ ok: boolean; error: Error | null }> => {
      if (mounted.current) {
        setLoading(true);
        setError(null);
      }
      // Omit p_vault_id for a GLOBAL grant (resolves the 2-arg RPC); include it
      // for a per-vault grant (the 3-arg RPC). The two arities are disjoint
      // server-side so there's no overload ambiguity.
      const args = vaultId
        ? { p_target: target, p_role: role, p_vault_id: vaultId }
        : { p_target: target, p_role: role };
      const { error: err } = await client.rpc("pdm_set_user_role", args);
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
