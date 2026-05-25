import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FolderId, QueryResult, VaultFile } from "./types";
import { fetchAllRows } from "./paginate";

export function useFiles(folder_id: FolderId | undefined): QueryResult<VaultFile[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!folder_id) {
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
        () => (client.from("files") as any).select("*").eq("folder_id", folder_id),
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
  }, [client, folder_id, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
