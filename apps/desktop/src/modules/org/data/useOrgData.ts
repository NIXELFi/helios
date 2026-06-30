import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";

// All Org & Access reads go through the `pm` schema (the client's default schema
// is `pdm`, so we must scope to `pm` like the PM module does). The role/capability
// definitions are world-readable to authenticated users (RLS select policies);
// the people directory comes from the admin-gated pm.list_people() RPC.

export interface MyCapability {
  capability_key: string;
  subteam_id: string | null; // null = applies everywhere (org-scoped)
}

export interface PersonRole {
  role: string;
  label: string;
  tag: string | null;
  scope: "org" | "subteam";
  subteam_id: string | null;
}

export interface Person {
  user_id: string;
  email: string | null;
  display_name: string | null;
  signup_subteam: string | null;
  roles: PersonRole[];
}

export interface OrgRole {
  id: string;
  key: string;
  label: string;
  tag: string | null;
  scope: "org" | "subteam";
  is_system: boolean;
  sort_order: number;
}

/** The signed-in user's effective capabilities, with a `can(cap, subteamId?)`
 *  helper that mirrors the server resolver: an org-scoped grant (subteam_id null)
 *  applies everywhere; a subteam grant applies only to that subteam. */
export function useMyCapabilities() {
  const client = useSupabaseClient();
  const [caps, setCaps] = useState<MyCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error: err } = await client.schema("pm").rpc("my_capabilities");
      if (!mounted) return;
      if (err) setError(new Error(err.message ?? String(err)));
      else setCaps((data as MyCapability[]) ?? []);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const can = useCallback(
    (cap: string, subteamId?: string | null) =>
      caps.some(
        (c) => c.capability_key === cap && (c.subteam_id === null || (!!subteamId && c.subteam_id === subteamId)),
      ),
    [caps],
  );

  // True if the user holds `cap` in ANY scope (org OR any subteam). The check for
  // org-wide actions that subteam-scoped roles (e.g. Lead) may also perform
  // regardless of which subteam they belong to — `can()` without a target subteam
  // id only honors org-scoped grants and would miss a subteam-scoped Lead.
  const canAnywhere = useCallback(
    (cap: string) => caps.some((c) => c.capability_key === cap),
    [caps],
  );

  // Re-run my_capabilities so newly-granted/revoked/edited permissions take
  // effect immediately instead of staying stale until a full reload.
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { caps, can, canAnywhere, loading, error, refetch };
}

/** Every account + their roles (admin-gated server-side; raises for others). */
export function usePeople() {
  const client = useSupabaseClient();
  const [data, setData] = useState<Person[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setError(null);
    (async () => {
      const { data: rows, error: err } = await client.schema("pm").rpc("list_people");
      if (!mounted) return;
      if (err) {
        setError(new Error(err.message ?? String(err)));
        setData(null);
      } else {
        setData((rows as Person[]) ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}

export interface Subteam {
  id: string;
  name: string;
  code: string;
  color: string | null;
  icon?: string | null;
}
export interface Project {
  id: string;
  name: string;
  program: "ic" | "ev" | null;
}
export interface Capability {
  key: string;
  label: string;
  description: string | null;
  scope: "org" | "subteam";
}
export interface RoleWithCaps extends OrgRole {
  capabilities: string[];
}

/** A `can(cap, subteamId?)` predicate, as returned by {@link useMyCapabilities}. */
export type CanFn = (cap: string, subteamId?: string | null) => boolean;

/** Server-side grant-subset rule (`pm.grant_role`/`pm.upsert_role`), mirrored on
 *  the client so the UI never offers a role/cap the RPC would reject: every
 *  capability the role grants must be one the caller holds in the target scope
 *  (`scopeSubteamId = null` ⇒ org scope). An org-wide grant of a cap satisfies
 *  every subteam, which `can` already encodes. */
export function roleCapsHeldInScope(
  capabilities: string[],
  can: CanFn,
  scopeSubteamId: string | null,
): boolean {
  return capabilities.every((capKey) => can(capKey, scopeSubteamId));
}

/** The capability set safe to send to `pm.upsert_role`: only caps the caller can
 *  actually grant org-wide. Filtering here prevents a disabled-but-selected cap
 *  (one the admin lacks) from being included in the payload and tripping the
 *  server's subset check — which previously made every save fail. */
export function grantableCapsPayload(selected: Iterable<string>, can: CanFn): string[] {
  return [...selected].filter((capKey) => can(capKey));
}

export function useSubteams() {
  const client = useSupabaseClient();
  const [data, setData] = useState<Subteam[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: rows } = await client.schema("pm").from("subteams").select("id,name,code,color,icon").order("name");
      if (mounted) setData((rows as Subteam[]) ?? []);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, refetch };
}

export function useProjects() {
  const client = useSupabaseClient();
  const [data, setData] = useState<Project[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: rows } = await client.schema("pm").from("projects").select("id,name,program").order("name");
      if (mounted) setData((rows as Project[]) ?? []);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, refetch };
}

/** The subteam↔project map, as a Set of `${projectId}:${subteamId}` keys. */
export function useProjectSubteams() {
  const client = useSupabaseClient();
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: rows } = await client.schema("pm").from("project_subteams").select("project_id,subteam_id");
      if (!mounted) return;
      const next = new Set<string>();
      for (const r of (rows as { project_id: string; subteam_id: string }[]) ?? []) {
        next.add(`${r.project_id}:${r.subteam_id}`);
      }
      setKeys(next);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { keys, refetch };
}

export function useCapabilities() {
  const client = useSupabaseClient();
  const [data, setData] = useState<Capability[]>([]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: rows } = await client.schema("pm").from("capabilities").select("key,label,description,scope");
      if (mounted) setData((rows as Capability[]) ?? []);
    })();
    return () => {
      mounted = false;
    };
  }, [client]);
  return data;
}

/** Roles plus the set of capability keys each one grants. */
export function useRolesWithCaps() {
  const client = useSupabaseClient();
  const [data, setData] = useState<RoleWithCaps[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [roles, links] = await Promise.all([
        client.schema("pm").from("roles").select("id,key,label,tag,scope,is_system,sort_order").order("sort_order"),
        client.schema("pm").from("role_capabilities").select("role_id,capability_key"),
      ]);
      if (!mounted) return;
      const byRole = new Map<string, string[]>();
      for (const l of (links.data as { role_id: string; capability_key: string }[]) ?? []) {
        const arr = byRole.get(l.role_id) ?? [];
        arr.push(l.capability_key);
        byRole.set(l.role_id, arr);
      }
      setData(
        ((roles.data as OrgRole[]) ?? []).map((r) => ({ ...r, capabilities: byRole.get(r.id) ?? [] })),
      );
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, refetch };
}

/** The role catalog (definitions), sorted for display. */
export function useRoles() {
  const client = useSupabaseClient();
  const [data, setData] = useState<OrgRole[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: rows, error: err } = await client
        .schema("pm")
        .from("roles")
        .select("id,key,label,tag,scope,is_system,sort_order")
        .order("sort_order", { ascending: true });
      if (!mounted) return;
      if (err) setError(new Error(err.message ?? String(err)));
      else setData((rows as OrgRole[]) ?? []);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
