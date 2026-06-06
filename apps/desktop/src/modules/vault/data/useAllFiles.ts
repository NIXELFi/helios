import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, VaultFile, VaultId } from "./types";
import { FILE_WITH_LATEST_SELECT } from "./types";
import { fetchAllRows } from "./paginate";
import { REFETCH, type RefetchSignal } from "./apply-events";

/** A list hook that also exposes `patch` for incremental realtime updates. */
export type PatchableFiles = QueryResult<VaultFile[]> & {
  /** Apply an in-memory update. `updater` returns the next array, the same
   *  reference for a no-op, or REFETCH to fall back to a full refetch. No-ops
   *  before the first load (the in-flight/next fetch covers it). */
  patch: (updater: (rows: VaultFile[]) => VaultFile[] | RefetchSignal) => void;
};

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
export function useAllFiles(vault_id: VaultId | undefined): PatchableFiles {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  // Mirror `data` so patch() can read the latest list synchronously (realtime
  // events fire between renders, and several can land in one tick).
  const dataRef = useRef<VaultFile[] | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

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
          .select(FILE_WITH_LATEST_SELECT)
          .eq("vault_id", vault_id)
          // Hide soft-deleted files from the normal list; the recycle bin
          // (useDeletedFiles) fetches them, and the reaper removes local copies.
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
  }, [client, vault_id, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((updater: (rows: VaultFile[]) => VaultFile[] | RefetchSignal) => {
    const prev = dataRef.current;
    if (prev === null) return; // not loaded yet — the in-flight/next fetch covers it
    const next = updater(prev);
    if (next === REFETCH) {
      setTick((t) => t + 1);
      return;
    }
    if (next === prev) return; // no-op → no re-render
    dataRef.current = next;
    setData(next);
  }, []);
  return { data, loading, error, refetch, patch };
}
