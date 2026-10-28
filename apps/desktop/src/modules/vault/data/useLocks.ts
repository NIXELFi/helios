import { useCallback, useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Lock, QueryResult } from "./types";
import { fetchAllRows } from "./paginate";
import { subscribeLockChanges } from "./lock-events";
import {
  applyOverlay,
  getLockOverlay,
  reconcileLockOverlay,
  subscribeLockOverlay,
} from "./lock-overlay";

/** Same active-lock set (id, file, holder, release state)? Used to keep the
 *  previous array identity across a refetch that changed nothing, so consumers
 *  keyed on `locks` (useAutoSync's pass, memoised joins) don't churn. */
function sameLocks(a: Lock[], b: Lock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.file_id !== y.file_id ||
      x.user_id !== y.user_id ||
      x.released_at !== y.released_at ||
      x.force_released_by !== y.force_released_by
    ) {
      return false;
    }
  }
  return true;
}

export function useLocks(): QueryResult<Lock[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Lock[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  // Re-render (no refetch) when the optimistic lock overlay changes, so an
  // actor's own checkout/cancel shows on the pill this frame.
  const [overlayTick, setOverlayTick] = useState(0);
  useEffect(() => subscribeLockOverlay(() => setOverlayTick((t) => t + 1)), []);

  // Subscribe to in-window lock mutations so a successful acquire/release/
  // force-unlock triggers an immediate refetch — instead of waiting for the
  // useVaultRealtime onLock event to land. Closes the brief staleness
  // window that the audit identified.
  useEffect(() => {
    return subscribeLockChanges(() => setTick((t) => t + 1));
  }, []);

  useEffect(() => {
    // `mounted` doubles as the supersede guard: the cleanup below runs when a
    // newer tick (or unmount) replaces this effect, so a slow older response
    // can never overwrite the newer tick's result.
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
        // Drop optimistic overlay entries the server now confirms, then publish
        // the canonical rows — applyOverlay below reflects the reduced overlay.
        reconcileLockOverlay(rows);
        setData((prev) => (prev && sameLocks(prev, rows) ? prev : rows));
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  // Project the optimistic overlay onto the canonical list. Same reference as
  // `data` when the overlay is empty (the common case), so this adds no churn.
  const view = useMemo(
    () => (data === null ? null : applyOverlay(data, getLockOverlay())),
    [data, overlayTick],
  );
  return { data: view, loading, error, refetch };
}
