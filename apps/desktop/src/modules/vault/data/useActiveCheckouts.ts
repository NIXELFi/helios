import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { subscribeLockChanges } from "./lock-events";

/** One active checkout, fully resolved server-side (pdm_list_active_checkouts).
 *  `file_name` is null when the file is another user's unpublished draft and
 *  the caller isn't an admin in that vault — the lock is visible, the name is
 *  private. */
export interface ActiveCheckoutRow {
  lock_id: string;
  file_id: string;
  file_name: string | null;
  vault_id: string;
  vault_name: string;
  folder_id: string | null;
  user_id: string;
  acquired_at: string;
  is_draft: boolean;
  deleted_at: string | null;
}

/**
 * Server-side lock→file→vault join for WhoHasWhat. Client-side joins can't
 * resolve other users' unpublished drafts (files_read draft privacy), which
 * made every draft checkout land in an "Other vaults" bucket. `supported`
 * is false when the RPC isn't deployed yet (pre-migration server) — the
 * screen then falls back to the legacy client-side join.
 */
export function useActiveCheckouts(): {
  data: ActiveCheckoutRow[] | null;
  /** null = probing; false = RPC not deployed (use the legacy path). */
  supported: boolean | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const client = useSupabaseClient();
  const [data, setData] = useState<ActiveCheckoutRow[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Refetch immediately on in-window lock mutations, like useLocks does.
  useEffect(() => subscribeLockChanges(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    (async () => {
      const { data: rows, error: err } = await client.rpc("pdm_list_active_checkouts");
      if (!mounted) return;
      if (err) {
        // PGRST202 = function not found → server predates the migration.
        const missing =
          err.code === "PGRST202" || /could not find the function/i.test(err.message ?? "");
        if (missing) {
          setSupported(false);
          setError(null);
        } else {
          setSupported(true);
          setError(new Error(err.message ?? String(err)));
        }
        setData(null);
      } else {
        setSupported(true);
        setError(null);
        setData((rows as ActiveCheckoutRow[]) ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, supported, loading, error, refetch };
}
