import { useCallback, useEffect, useState } from "react";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";

/**
 * Does the signed-in account hold ANY org role (a pm role membership from
 * Org & Access, or a legacy pdm vault role)? Backed by the pm.is_org_member()
 * SECURITY DEFINER probe — the same predicate the default-deny RLS policies
 * gate on (20260714010000), so the UI and the database can never disagree
 * about who is "in".
 *
 * `member` is `null` while unknown (signed out, loading, or probe failed).
 * Callers should treat null as "don't gate" — the RLS policies are the real
 * enforcement; this hook only decides whether to show the friendly
 * "contact your team lead" screen instead of a wall of empty modules.
 *
 * Refetches when the signed-in identity changes and on window focus, so a
 * user who just got granted a role gets in with an alt-tab instead of a
 * restart.
 */
export function useOrgAccess(): {
  member: boolean | null;
  /** Holds a role-granting capability (org.grant_roles / pm.grant_subteam_roles)
   *  — gates the Org & Access rail entry alongside the legacy owner/admin
   *  role, so capability-only leads can reach the tool their server-side
   *  grants already authorize. */
  canManageOrg: boolean;
  recheck: () => void;
} {
  const client = useSupabaseClientOrNull();
  const user = useUser();
  const userId = user?.id ?? null;
  const [member, setMember] = useState<boolean | null>(null);
  const [canManageOrg, setCanManageOrg] = useState(false);
  const [tick, setTick] = useState(0);

  const recheck = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setMember(null);
    setCanManageOrg(false);
    if (!client || !userId) return;
    let on = true;
    (async () => {
      try {
        const { data, error } = await client.schema("pm").rpc("is_org_member");
        if (!on) return;
        if (error) {
          // Degrade to "unknown" (no gate) — RLS still protects the data.
          console.error("useOrgAccess: is_org_member probe failed", error);
          setMember(null);
          return;
        }
        setMember(data === true);
        if (data !== true) return;
        const { data: caps } = await client.schema("pm").rpc("my_capabilities");
        if (!on) return;
        const keys = new Set(
          ((caps as Array<{ capability_key: string }>) ?? []).map((c) => c.capability_key),
        );
        setCanManageOrg(keys.has("org.grant_roles") || keys.has("pm.grant_subteam_roles"));
      } catch (e) {
        // Same degrade path for a thrown probe (offline, stub client in
        // tests): unknown ≠ locked out.
        if (on) setMember(null);
      }
    })();
    return () => { on = false; };
  }, [client, userId, tick]);

  // A no-access user's most likely next step happens OUTSIDE the app (their
  // lead grants them a role). Recheck on focus so returning to the window is
  // enough to get in.
  useEffect(() => {
    if (member !== false) return;
    function onFocus() { recheck(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [member, recheck]);

  return { member, canManageOrg, recheck };
}
