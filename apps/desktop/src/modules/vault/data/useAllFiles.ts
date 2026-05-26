import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultFile, VaultId } from "./types";
import { fetchAllRows } from "./paginate";

/**
 * Fetches ALL files across every folder in a vault. Used by the unmatched-
 * local detection logic which must consider the entire vault, not just the
 * currently-selected folder.
 *
 * Paginated via .range() because vaults can hold many thousands of files and
 * PostgREST's default response cap is 1000 rows. Silent truncation here is
 * how the SDM26 import (4,446 files) showed up missing in the file table on
 * 2026-05-25.
 */
export function useAllFiles(vault_id: VaultId | undefined): QueryResult<VaultFile[]> {
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
        // Stable ORDER BY for safe pagination — see paginate.ts. `id` is the
        // PK so order is guaranteed stable across pages; the caller sorts
        // by name/path before rendering.
        () => (client.from("files") as any)
          .select("*")
          .eq("vault_id", vault_id)
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
