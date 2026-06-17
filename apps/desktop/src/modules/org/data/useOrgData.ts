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
  }, [client]);

  const can = useCallback(
    (cap: string, subteamId?: string | null) =>
      caps.some(
        (c) => c.capability_key === cap && (c.subteam_id === null || (!!subteamId && c.subteam_id === subteamId)),
      ),
    [caps],
  );

  return { caps, can, loading, error };
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
