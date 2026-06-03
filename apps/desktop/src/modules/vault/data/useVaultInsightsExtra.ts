import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultId } from "./types";

/** Server-aggregated "deep analytics" for a vault (pdm.vault_insights_extra RPC).
 *  One round trip returns small pre-aggregated jsonb — the client never fetches
 *  the underlying thousands of version/ref rows. */
export interface VaultInsightsExtra {
  activity_by_month: { month: string; commits: number }[];
  contributors: { author_id: string | null; commits: number }[];
  provenance: { glassy: number; native: number };
  checkouts: {
    active: number;
    force_released_total: number;
    longest_active: { file_id: string; user_id: string; acquired_at: string }[];
  };
  reuse: {
    most_referenced: { file_id: string; refs: number }[];
    orphans: number;
    total_links: number;
  };
  datacard: { parts_total: number; with_card: number };
}

export function useVaultInsightsExtra(vault_id: VaultId | undefined): QueryResult<VaultInsightsExtra> {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultInsightsExtra | null>(null);
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
      const { data: res, error: err } = await (client.rpc as any)("vault_insights_extra", {
        p_vault_id: vault_id,
      });
      if (!mounted) return;
      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        setData(null);
      } else {
        setData(res as VaultInsightsExtra);
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
