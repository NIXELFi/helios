import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, QueryResult } from "./types";
import { fetchAllRows } from "./paginate";

/**
 * Every live folder across EVERY vault the caller can see (RLS-scoped).
 * WhoHasWhatScreen uses this to render human-readable paths for checkouts in
 * any vault, not just the active one. Folder counts are small relative to
 * files, so an unscoped paginated fetch is fine here.
 */
export function useCrossVaultFolders(): QueryResult<Folder[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Folder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { rows, error: err } = await fetchAllRows<Folder>(
        // Stable ORDER BY for safe pagination — see paginate.ts.
        () => (client.from("folders") as any)
          .select("*")
          .is("deleted_at", null)
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
