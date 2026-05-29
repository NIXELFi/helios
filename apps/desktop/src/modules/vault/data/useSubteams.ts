import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, Subteam } from "./types";

/** The managed subteam list (pdm.subteams), ordered by sort_order. Readable
 *  by anyone (anon + authenticated) so the sign-up form can show it pre-auth. */
export function useSubteams(): QueryResult<Subteam[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Subteam[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await (client.from("subteams") as any)
        .select("*")
        .order("sort_order", { ascending: true });
      if (!mounted) return;
      if (err) {
        setError(new Error(err.message ?? String(err)));
        setData(null);
      } else {
        setData((rows as Subteam[]) ?? []);
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
