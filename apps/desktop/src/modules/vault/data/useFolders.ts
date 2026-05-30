import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, QueryResult, VaultId } from "./types";
import { fetchAllRows } from "./paginate";

export function useFolders(vault_id: VaultId | undefined): QueryResult<Folder[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Folder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!vault_id) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { rows, error: err } = await fetchAllRows<Folder>(
        // Explicit stable order: PostgREST does not guarantee a stable order
        // across .range() pages without an ORDER BY, so chunks of a paginated
        // response could duplicate or skip rows. `name` is not unique, so it
        // alone is insufficient — append the PK `id` as a tiebreaker for a
        // deterministic total order. Sorting by name also gives the
        // FolderTree a predictable initial order.
        () => (client.from("folders") as any)
          .select("*")
          .eq("vault_id", vault_id)
          .order("name", { ascending: true })
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
  }, [client, vault_id, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
