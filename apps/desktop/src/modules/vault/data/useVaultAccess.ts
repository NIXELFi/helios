import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";

export type VaultAccessStatus = "loading" | "member" | "no-role" | "error";

export interface VaultAccess {
  status: VaultAccessStatus;
  /** Populated only when status === "error" — the raw message from the
   *  user_roles lookup, so a self-hoster can tell a backend misconfig
   *  (missing pdm schema, RLS, etc.) apart from "just not invited yet". */
  error: string | null;
}

/** Decide whether the signed-in user may actually use the Vault.
 *
 *  A fresh sign-up authenticates fine but has NO row in `pdm.user_roles`.
 *  Per the storage RLS (migration 20260511000700, a deliberate security
 *  fix), a role-less user can list folder/file *names* but cannot download
 *  bytes or write anything — so the Vault would look empty + broken to them.
 *  This hook lets the module show an explicit "ask an admin for access"
 *  notice instead of that confusing half-state.
 *
 *  - `loading` — query in flight (or no user yet).
 *  - `member`  — has a role row (admin / editor / viewer) → full Vault.
 *  - `no-role` — authenticated but not yet granted a role.
 *  - `error`   — the lookup itself failed (likely a backend misconfig).
 */
export function useVaultAccess(): VaultAccess {
  const client = useSupabaseClient();
  const user = useUser();
  const [access, setAccess] = useState<VaultAccess>({ status: "loading", error: null });

  useEffect(() => {
    if (!user) {
      setAccess({ status: "loading", error: null });
      return;
    }
    let mounted = true;
    setAccess({ status: "loading", error: null });
    (async () => {
      // NOT .maybeSingle(): per-vault roles (20260531000000) mean a user can
      // legitimately hold SEVERAL rows (a global one plus per-vault ones) —
      // maybeSingle errors on >1 row and showed members the backend-misconfig
      // screen. Any row at all means "member".
      const { data, error } = await (client.from("user_roles") as any)
        .select("role")
        .eq("user_id", user.id)
        .limit(1);
      if (!mounted) return;
      if (error) {
        setAccess({ status: "error", error: error.message ?? String(error) });
        return;
      }
      setAccess({ status: (data?.length ?? 0) > 0 ? "member" : "no-role", error: null });
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return access;
}
