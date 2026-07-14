import { useEffect, useState } from "react";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";

/**
 * The role string shown on identity surfaces (sidebar user pill, vault
 * Settings). Display only — never use this for gating.
 *
 * Roles now live in two systems: the legacy global pdm.user_roles row
 * (owner/admin/editor/viewer) and Org & Access role memberships (Owner /
 * Executive / Lead / Engineer / …). Members granted purely through the org
 * tool used to see "(no role assigned)" even while holding full access
 * through the capability bridge. The org label is preferred when one exists —
 * the org tool is the source of truth going forward; the legacy role is the
 * fallback for members who predate it.
 *
 * When a user holds several org roles (lead@Chassis + engineer@Aero), the
 * highest-ranked one (lowest pm.roles.sort_order) is shown.
 */
export function useMyDisplayRole(): string | null {
  const client = useSupabaseClientOrNull();
  const user = useUser();
  const userId = user?.id ?? null;
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    setRole(null);
    if (!client || !userId) return;
    let on = true;
    (async () => {
      // Org & Access memberships first (FK-embedded label + rank). RLS:
      // role_memberships is self-readable; pm.roles is org-member-readable.
      // Its own try so a failed org probe (older backend, stub client in
      // tests) still falls through to the legacy label below.
      try {
        const { data: memberships } = await client
          .schema("pm")
          .from("role_memberships")
          .select("roles(label, sort_order)")
          .eq("user_id", userId);
        if (!on) return;
        // supabase-js types an FK embed as an array even for a to-one join;
        // normalize object-or-array to a flat label list.
        type RoleRef = { label: string; sort_order: number };
        const labels = ((memberships ?? []) as unknown as Array<{ roles: RoleRef | RoleRef[] | null }>)
          .flatMap((m) => (m.roles == null ? [] : Array.isArray(m.roles) ? m.roles : [m.roles]))
          .sort((a, b) => a.sort_order - b.sort_order);
        const top = labels[0];
        if (top) {
          setRole(top.label);
          return;
        }
      } catch {
        // fall through to the legacy label
      }
      try {
        // Legacy fallback: the GLOBAL pdm role row (vault_id null), same
        // resolution as useMyRole — per-vault rows are not a global identity.
        const { data: rows } = await (client.from("user_roles") as any)
          .select("role, vault_id")
          .eq("user_id", userId);
        if (!on) return;
        const global = ((rows ?? []) as Array<{ role: string; vault_id: string | null }>).find(
          (r) => r.vault_id == null,
        );
        setRole(global?.role ?? null);
      } catch {
        // Display-only: degrade to no label rather than surfacing an error.
        if (on) setRole(null);
      }
    })();
    return () => { on = false; };
  }, [client, userId]);

  return role;
}
