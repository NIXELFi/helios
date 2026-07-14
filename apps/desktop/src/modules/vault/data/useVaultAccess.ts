import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";

export type VaultAccessStatus = "loading" | "member" | "no-role" | "error";

export interface VaultAccess {
  status: VaultAccessStatus;
  /** Populated only when status === "error" — the raw message from the
   *  access probe, so a self-hoster can tell a backend misconfig
   *  (missing pdm schema, RLS, etc.) apart from "just not invited yet". */
  error: string | null;
}

/** Decide whether the signed-in user may actually use the Vault.
 *
 *  Access has two sources of truth (20260714000000 capability bridge): a
 *  legacy `pdm.user_roles` row OR an Org & Access role carrying the
 *  vault.view capability. The old implementation self-selected user_roles,
 *  which walled out every capability-only member (the default onboarding
 *  path since the org tool became the way roles are granted) — so this now
 *  asks the `pdm_has_vault_access` definer probe, the same predicate the
 *  RLS gates derive from.
 *
 *  - `loading` — probe in flight (or no user yet).
 *  - `member`  — has vault access (legacy role or vault.view capability).
 *  - `no-role` — authenticated but no grant yet.
 *  - `error`   — the probe itself failed (likely a backend misconfig).
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
      try {
        const { data, error } = await (client as any).rpc("pdm_has_vault_access");
        if (!mounted) return;
        if (error) {
          setAccess({ status: "error", error: error.message ?? String(error) });
          return;
        }
        setAccess({ status: data === true ? "member" : "no-role", error: null });
      } catch (e) {
        if (mounted) setAccess({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return access;
}
