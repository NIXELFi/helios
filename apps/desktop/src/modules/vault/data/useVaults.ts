import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, Vault } from "./types";

// Every useVaults instance refetches when a vault row changes in this window
// (e.g. archiving in Settings must reach the Browse screen at once).
const vaultChangeListeners = new Set<() => void>();
export function notifyVaultsChanged(): void {
  for (const l of vaultChangeListeners) l();
}

export function useVaults(): QueryResult<Vault[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Vault[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await (client.from("vaults") as any).select("*");
      if (!mounted) return;
      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        setData(null);
      } else {
        setData(rows ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    vaultChangeListeners.add(refetch);
    return () => { vaultChangeListeners.delete(refetch); };
  }, [refetch]);
  return { data, loading, error, refetch };
}
