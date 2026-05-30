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
      const { data } = await client
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle<RoleRow>();
      if (mounted) setRole(data?.role ?? null);
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return role;
}
