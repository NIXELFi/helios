import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Lock, QueryResult } from "./types";
import { fetchAllRows } from "./paginate";
import { subscribeLockChanges } from "./lock-events";

export function useLocks(): QueryResult<Lock[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Lock[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Subscribe to in-window lock mutations so a successful acquire/release/
  // force-unlock triggers an immediate refetch — instead of waiting for the
  // useVaultRealtime onLock event to land. Closes the brief staleness
  // window that the audit identified.
  useEffect(() => {
    return subscribeLockChanges(() => setTick((t) => t + 1));
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      // Paginated — locks is cross-vault and once total active locks
      // crossed PostgREST's 1,000-row default it would silently truncate,
      // which is how auto-sync could clobber a user holding a lock that
      // fell off the response window.
      const { rows, error: err } = await fetchAllRows<Lock>(
        // Stable ORDER BY for safe pagination — see paginate.ts.
        () => (client.from("locks") as any)
          .select("*")
          .is("released_at", null)
          .order("id", { ascending: true }),
      );
      if (!mounted) return;
      if (err) {
        setError(err);
        setData(null);
      } else {
        setData(rows);
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
