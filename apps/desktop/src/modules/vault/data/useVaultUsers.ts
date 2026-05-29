import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultUser } from "./types";

/** Every auth user + their role, via the admin-gated `pdm_admin_list_users`
 *  RPC. The function raises if the caller isn't an admin, so a non-admin
 *  consumer surfaces that as `error`. The client uses `db.schema = 'pdm'`,
 *  so `rpc('pdm_admin_list_users')` resolves to `pdm.pdm_admin_list_users()`. */
export function useVaultUsers(): QueryResult<VaultUser[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await client.rpc("pdm_admin_list_users");
      if (!mounted) return;
      if (err) {
        setError(new Error(err.message ?? String(err)));
        setData(null);
      } else {
        setData((rows as VaultUser[]) ?? []);
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
