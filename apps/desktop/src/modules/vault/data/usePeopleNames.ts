import { useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";

type SupabaseClient = ReturnType<typeof useSupabaseClient>;
import type { UserId, VaultUser } from "./types";

interface DirectoryRow {
  id: string;
  name: string | null;
  email: string | null;
}

// One directory fetch per client per session, shared by every consumer (the
// rail, History, the detail panel and the notification feed all mount at once).
// Names change rarely; a failed fetch is dropped so the next mount retries.
const directoryCache = new WeakMap<SupabaseClient, Promise<Map<UserId, string>>>();

function fetchDirectory(client: SupabaseClient): Promise<Map<UserId, string>> {
  const hit = directoryCache.get(client);
  if (hit) return hit;
  const p = (async () => {
    // The vault client defaults to db.schema = 'pdm'; the people directory
    // lives in pm. pm.list_directory is granted to every signed-in user (it
    // backs PM's assignee pickers), unlike the admin-gated vault user RPCs.
    const { data, error } = await client.schema("pm").rpc("list_directory");
    if (error) throw new Error(error.message ?? String(error));
    const m = new Map<UserId, string>();
    for (const r of Array.isArray(data) ? (data as DirectoryRow[]) : []) {
      const label = r.name?.trim() || r.email?.trim();
      if (r.id && label) m.set(r.id as UserId, label);
    }
    return m;
  })();
  directoryCache.set(client, p);
  p.catch(() => directoryCache.delete(client));
  return p;
}

/**
 * user id → human name for "who did it" labels on history surfaces.
 *
 * The vault's own user lists (pdm_admin_list_users / pdm_list_vault_roles) are
 * admin-gated, so a regular member got an EMPTY map and every author read as
 * unknown. This merges the org-wide people directory (readable by everyone) as
 * the base with the vault user list on top (display name first), so admins and
 * members see the same names. Best-effort: either source failing just leaves
 * fewer names resolved. Takes the caller's vault user list (every screen
 * already fetches one) rather than issuing another admin RPC per consumer.
 */
export function usePeopleNames(vaultUsers?: VaultUser[] | null): Map<UserId, string> {
  const client = useSupabaseClient();
  const [directory, setDirectory] = useState<Map<UserId, string> | null>(null);

  useEffect(() => {
    let mounted = true;
    try {
      fetchDirectory(client).then(
        (m) => mounted && setDirectory(m),
        () => {},
      );
    } catch {
      // Client without schema() (some test doubles) — vault users only.
    }
    return () => {
      mounted = false;
    };
  }, [client]);

  return useMemo(() => {
    const m = new Map<UserId, string>(directory ?? []);
    for (const u of Array.isArray(vaultUsers) ? vaultUsers : []) {
      const label = u.display_name?.trim() || u.email;
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [directory, vaultUsers]);
}
