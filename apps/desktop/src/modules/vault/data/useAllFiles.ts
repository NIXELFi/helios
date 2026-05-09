import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultFile, VaultId } from "./types";

/**
 * Fetches ALL files across every folder in a vault. Used by the unmatched-
 * local detection logic which must consider the entire vault, not just the
 * currently-selected folder.
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
      const { data: rows, error: err } = await (client.from("files") as any)
        .select("*")
        .eq("vault_id", vault_id);
      if (!mounted) return;
      if (err) {
        setError(new Error(err.message ?? String(err)));
        setData(null);
      } else {
        setData(rows ?? []);
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
