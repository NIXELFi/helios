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

/** May the current user create a NEW vault? Mirrors the vaults_insert_admin
 *  policy (20260714030000): `pdm.is_admin_in(id)` evaluated for a
 *  not-yet-existing id, which only a GLOBAL legacy admin row or the
 *  vault.admin capability can satisfy — so probing is_admin_in with a fresh
 *  random uuid evaluates exactly that predicate. (The old gate was the
 *  legacy-only global pdm_is_admin, which hid the New-vault form from
 *  capability-only admins the policy accepts.) */
export function useCanCreateVault(): boolean {
  const [probeId] = useState(() => crypto.randomUUID());
  return useVaultPermission("pdm_is_admin_in", probeId);
}
