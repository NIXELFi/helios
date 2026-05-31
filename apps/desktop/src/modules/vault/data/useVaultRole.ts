import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { VaultId } from "./types";

/**
 * Per-vault permission checks, backed by the server-side `pdm_is_admin_in` /
 * `pdm_can_edit_in` RPCs (which treat a global role as authoritative in every
 * vault). These gate UI affordances for the ACTIVE vault; the RLS + RPCs
 * enforce the same rules server-side regardless of what the client shows.
 *
 * `null` vaultId (no active vault yet) resolves to false.
 */
function useVaultPermission(rpc: "pdm_is_admin_in" | "pdm_can_edit_in", vaultId: VaultId | null): boolean {
  const client = useSupabaseClient();
  const user = useUser();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!user || !vaultId) {
      setAllowed(false);
      return;
    }
    let mounted = true;
    (async () => {
      const { data } = await client.rpc(rpc, { p_vault_id: vaultId });
      if (mounted) setAllowed(Boolean(data));
    })();
    return () => {
      mounted = false;
    };
  }, [client, user, vaultId, rpc]);

  return allowed;
}

/** Is the current user an admin (or owner) of this vault? */
export function useIsVaultAdmin(vaultId: VaultId | null): boolean {
  return useVaultPermission("pdm_is_admin_in", vaultId);
}

/** May the current user edit (admin/editor/owner) in this vault? */
export function useCanEditVault(vaultId: VaultId | null): boolean {
  return useVaultPermission("pdm_can_edit_in", vaultId);
}
