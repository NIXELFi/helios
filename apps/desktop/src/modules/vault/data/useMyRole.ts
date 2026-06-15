import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { VaultRole } from "./types";

// The DB's pdm.user_roles.role column can be any VaultRole — including
// "owner" (the bootstrap super-user). Reuse VaultRole so the type matches what
// the query actually returns; `null` covers the no-role / no-user case.
export type MyRole = VaultRole | null;

/** The shape of the single column we select from pdm.user_roles. */
interface RoleRow {
  role: VaultRole | null;
}

export function useMyRole(): MyRole {
  const client = useSupabaseClient();
  const user = useUser();
  const [role, setRole] = useState<MyRole>(null);

  useEffect(() => {
    if (!user) {
      setRole(null);
      return;
    }
    let mounted = true;
    (async () => {
      // Per-vault roles mean a user can have several user_roles rows; this
      // hook reports the GLOBAL role. We fetch all of the user's rows and pick
      // the global one (vault_id null/absent) in JS rather than filtering with
      // `.is("vault_id", null)` — that filter (and selecting the column) errors
      // against a backend whose user_roles predates the vault_id column (not
      // yet migrated). `select("*")` is column-agnostic.
      const { data } = await client
        .from("user_roles")
        .select("*")
        .eq("user_id", user.id);
      const rows = (data ?? []) as Array<RoleRow & { vault_id?: string | null }>;
      // GLOBAL role only: a row with no vault_id (== null also matches the
      // legacy pre-vault_id-column shape, where every row is effectively
      // global). Do NOT fall back to rows[0] — that returned a PER-VAULT role
      // as if it were global, so an editor in vault A wrongly got edit
      // affordances in vault B. No global row → null; per-vault edit rights
      // come from the vault-scoped hooks (useCanEditVault / useIsVaultAdmin).
      const global = rows.find((r) => r.vault_id == null);
      if (mounted) setRole(global?.role ?? null);
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return role;
}
