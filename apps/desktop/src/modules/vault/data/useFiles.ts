import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FolderId, VaultFile } from "./types";
import { FILE_WITH_LATEST_SELECT } from "./types";
import { fetchAllRows } from "./paginate";
import { REFETCH, type RefetchSignal } from "./apply-events";
import type { PatchableFiles } from "./useAllFiles";

export function useFiles(folder_id: FolderId | undefined): PatchableFiles {
  const client = useSupabaseClient();
  const [data, setData] = useState<VaultFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const dataRef = useRef<VaultFile[] | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Folder the current `data` belongs to. Navigating to a DIFFERENT folder
  // must drop the rows immediately — holding them while the new query is in
  // flight rendered the PREVIOUS folder's files under the newly-clicked
  // folder (STALE-FOLDER). A same-folder refetch (tick) keeps the rows so
  // realtime-triggered refreshes don't flicker the table.
  const folderOfDataRef = useRef<FolderId | undefined>(undefined);

  useEffect(() => {
    if (!folder_id) {
      folderOfDataRef.current = undefined;
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (folderOfDataRef.current !== folder_id) {
      folderOfDataRef.current = folder_id;
      dataRef.current = null;
      setData(null);
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { rows, error: err } = await fetchAllRows<VaultFile>(
        // Stable, UNIQUE ORDER BY is required for safe pagination — see
        // paginate.ts. `name` alone is not unique, so rows could be skipped
        // or duplicated at .range() page boundaries; append the PK `id` as a
        // tiebreaker for a deterministic total order (cf. useAllFiles).
        () => (client.from("files") as any)
          .select(FILE_WITH_LATEST_SELECT)
          .eq("folder_id", folder_id)
          .is("deleted_at", null) // soft-deleted files live in the recycle bin
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
  }, [client, folder_id, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((updater: (rows: VaultFile[]) => VaultFile[] | RefetchSignal) => {
    const prev = dataRef.current;
    if (prev === null) return;
    const next = updater(prev);
    if (next === REFETCH) {
      setTick((t) => t + 1);
      return;
    }
    if (next === prev) return;
    dataRef.current = next;
    setData(next);
  }, []);
  return { data, loading, error, refetch, patch };
}
