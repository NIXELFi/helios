import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, FolderId, QueryResult, VaultFile, VaultId } from "./types";
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

/** The whole-vault catalog plus the two targeted refreshes that replace a full
 *  re-pull when only part of the vault moved. */
export type VaultFiles = PatchableFiles & {
  /** Re-read ONE folder (null = the vault root) from the server and merge it
   *  into the catalog. Used after a mutation in the folder the user is looking
   *  at, where the old code re-pulled every file in the vault. */
  refreshFolder: (folderId: FolderId | null) => void;
  /** Re-read specific files by id and merge them in. Used when the cursor's
   *  version count moves: only the checked-in files are re-read. */
  refreshIds: (ids: FileId[]) => void;
};

/** Which rows a merge is allowed to consider authoritative. */
export type MergeScope = { folderId: FolderId | null } | { ids: FileId[] };

/** PostgREST rejects very long URLs, so an `in.(…)` list is sent in batches. */
const ID_BATCH = 200;

/** Shallow value equality, one level deep so the embedded `latest` object is
 *  compared by value too. Rows always come back as FRESH objects from
 *  PostgREST, so reference equality can never answer "did this row change?" —
 *  without a value compare, every poll would replace the whole array and
 *  re-render the entire file table for nothing. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function sameRow(a: VaultFile, b: VaultFile): boolean {
  const ak = Object.keys(a) as Array<keyof VaultFile>;
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => sameValue(a[k], b[k]));
}

/**
 * Merge a targeted server read into the in-memory catalog.
 *
 * - a row present in both is replaced (by value; an unchanged row keeps its
 *   object identity so downstream memos don't churn),
 * - a row only in `incoming` is appended,
 * - under a FOLDER scope, a row of that folder that `incoming` does not contain
 *   was moved out or deleted, so it is dropped — the folder query is the
 *   authority for its own folder,
 * - under an IDS scope nothing is dropped: an id that came back empty is not
 *   evidence of a delete (RLS could hide it, or it could belong to another
 *   vault), and the cursor's liveFiles count is what covers real deletes.
 *
 * Returns the SAME array reference when nothing changed.
 */
export function mergeRows(
  current: VaultFile[],
  incoming: VaultFile[],
  scope: MergeScope,
): VaultFile[] {
  const pending = new Map<FileId, VaultFile>();
  for (const row of incoming) pending.set(row.id, row);

  const folderScoped = !("ids" in scope);
  const scopeFolderId = folderScoped ? (scope as { folderId: FolderId | null }).folderId : null;

  let changed = false;
  const out: VaultFile[] = [];
  for (const row of current) {
    const next = pending.get(row.id);
    if (next) {
      pending.delete(row.id);
      if (sameRow(row, next)) out.push(row);
      else {
        out.push(next);
        changed = true;
      }
      continue;
    }
    if (folderScoped && (row.folder_id ?? null) === scopeFolderId) {
      changed = true; // gone from the folder the server just told us about
      continue;
    }
    out.push(row);
  }
  for (const row of pending.values()) {
    out.push(row);
    changed = true;
  }
  return changed ? out : current;
}

/**
 * Fetches ALL files across every folder in a vault. Used by the unmatched-
 * local detection logic which must consider the entire vault, not just the
 * currently-selected folder.
 *
 * Paginated via .range() because vaults can hold many thousands of files and
 * PostgREST's default response cap is 1000 rows. Silent truncation here is
 * how the SDM26 import (4,446 files) showed up missing in the file table on
 * 2026-05-25.
 *
 * ONE instance per vault: the catalog page was 30% of all database time in the
 * 2026-09-09 load audit, largely because VaultHome and BrowseScreen each ran
 * this hook. It is now provided once from VaultHome via vault-files-context.
 */
export function useAllFiles(vault_id: VaultId | undefined): VaultFiles {
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
  // The vault the current list belongs to, read by the async targeted refreshes
  // so a response that lands after a vault switch is dropped instead of merging
  // vault A's rows into vault B's catalog.
  const vaultRef = useRef(vault_id);
  useEffect(() => {
    vaultRef.current = vault_id;
  }, [vault_id]);

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

  /** Shared tail of both targeted refreshes: run the read, then merge — unless
   *  the active vault changed while the request was in flight, or the catalog
   *  hasn't loaded at all yet (the pending full fetch already covers it). */
  const mergeFetched = useCallback(
    async (vid: VaultId, build: () => any, scope: MergeScope) => {
      const { rows, error: err } = await fetchAllRows<VaultFile>(build);
      if (vaultRef.current !== vid) return; // vault switched under us
      // A failed targeted read falls back to the full refetch rather than
      // leaving the view stale — the same discipline as the REFETCH sentinel.
      if (err) {
        setTick((t) => t + 1);
        return;
      }
      patch((cur) => mergeRows(cur, rows, scope));
    },
    [patch],
  );

  const refreshFolder = useCallback(
    (folderId: FolderId | null) => {
      const vid = vault_id;
      if (!vid) return;
      void mergeFetched(
        vid,
        () => {
          const q = (client.from("files") as any)
            .select(FILE_WITH_LATEST_SELECT)
            .eq("vault_id", vid)
            .is("deleted_at", null);
          return (folderId === null ? q.is("folder_id", null) : q.eq("folder_id", folderId))
            .order("id", { ascending: true });
        },
        { folderId },
      );
    },
    [client, vault_id, mergeFetched],
  );

  const refreshIds = useCallback(
    (ids: FileId[]) => {
      const vid = vault_id;
      if (!vid || ids.length === 0) return;
      const unique = Array.from(new Set(ids));
      for (let i = 0; i < unique.length; i += ID_BATCH) {
        const batch = unique.slice(i, i + ID_BATCH);
        void mergeFetched(
          vid,
          () => (client.from("files") as any)
            .select(FILE_WITH_LATEST_SELECT)
            .eq("vault_id", vid)
            .is("deleted_at", null)
            .in("id", batch)
            .order("id", { ascending: true }),
          { ids: batch },
        );
      }
    },
    [client, vault_id, mergeFetched],
  );

  return { data, loading, error, refetch, patch, refreshFolder, refreshIds };
}
