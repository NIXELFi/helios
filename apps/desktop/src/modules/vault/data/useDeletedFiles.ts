import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultFile, VaultId } from "./types";
import { FILE_WITH_LATEST_SELECT } from "./types";
import { fetchAllRows } from "./paginate";

/**
 * Fetches the soft-deleted files in a vault (the recycle bin) — every row whose
 * `deleted_at` is non-null, most-recently-deleted first. Mirror of useAllFiles
 * with the delete filter inverted (useFiles/useAllFiles exclude these rows).
 *
 * Paginated via .range() (see paginate.ts) since a long-lived vault's recycle
 * bin can exceed PostgREST's default 1000-row cap.
 */
export function useDeletedFiles(vault_id: VaultId | undefined): QueryResult<VaultFile[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultFile[] | null>(null);
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
      const { rows, error: err } = await fetchAllRows<VaultFile>(
        // `deleted_at` is not unique, so append the PK `id` as a tiebreaker for
        // a deterministic total order across .range() pages (cf. useFiles).
        () => (client.from("files") as any)
          .select(FILE_WITH_LATEST_SELECT)
          .eq("vault_id", vault_id)
          .not("deleted_at", "is", null)
          .order("deleted_at", { ascending: false })
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
