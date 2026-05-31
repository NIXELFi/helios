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
      const global = rows.find((r) => r.vault_id == null) ?? rows[0];
      if (mounted) setRole(global?.role ?? null);
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return role;
}
