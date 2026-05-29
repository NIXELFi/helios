import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { UserId, VaultRole } from "./types";

/** Grant or change a user's role via `pdm_set_user_role`. Authorization (only
 *  the owner may grant/change admin; any admin may grant editor/viewer) is
 *  enforced server-side inside the SECURITY DEFINER function — the client UI
 *  mirrors those rules only for affordance. 'owner' is intentionally not an
 *  accepted argument. */
export function useSetUserRole() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (target: UserId, role: Exclude<VaultRole, "owner">): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_set_user_role", {
        p_target: target,
        p_role: role,
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
