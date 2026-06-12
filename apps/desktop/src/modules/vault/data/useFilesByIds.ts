import { useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, FolderId, VaultId } from "./types";

/** Minimal file row for lock resolution — fetched by id across EVERY vault the
 *  caller can see, deleted rows included (a file can be soft-deleted while its
 *  lock is still active, and WhoHasWhat must still label that checkout). */
export interface LockFileRow {
  id: FileId;
  vault_id: VaultId;
  folder_id: FolderId | null;
  name: string;
  deleted_at: string | null;
}

// PostgREST encodes .in() into the URL; keep each chunk well under length
// limits. Locks are few in practice, so this rarely exceeds one chunk.
const CHUNK = 150;

/**
 * Fetch file rows by id, unscoped to a vault. Used by WhoHasWhatScreen to
 * resolve cross-vault locks to a file name + vault without paging every file
 * of every vault. Rows from vaults the caller can't read are simply absent
 * (RLS) — the caller renders those locks under an "other vaults" fallback.
 *
 * `data` is keyed to the CURRENT id set: when the ids change, it reads null
 * until the matching fetch lands. Returning the previous set's rows during
 * that gap made WhoHasWhat commit a frame that grouped every lock under
 * "Other vaults" and then remounted it a tick later (STALE-IDS flash).
 */
export function useFilesByIds(ids: FileId[]): {
  data: LockFileRow[] | null;
  loading: boolean;
  error: Error | null;
} {
  const client = useSupabaseClient();
  // Rows are stored WITH the key they were fetched for, so a stale result can
  // never be served for a new id set.
  const [state, setState] = useState<{ key: string; rows: LockFileRow[] } | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Stable identity for the id set so a same-content array from a re-render
  // doesn't refetch.
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);

  useEffect(() => {
    const wanted = key === "" ? [] : key.split(",");
    if (wanted.length === 0) {
      setState({ key, rows: [] });
      setError(null);
      return;
    }
    let mounted = true;
    setError(null);
    (async () => {
      try {
        const rows: LockFileRow[] = [];
        for (let i = 0; i < wanted.length; i += CHUNK) {
          const chunk = wanted.slice(i, i + CHUNK);
          const { data: page, error: err } = await (client.from("files") as any)
            .select("id, vault_id, folder_id, name, deleted_at")
            .in("id", chunk);
          if (!mounted) return;
          if (err) {
            setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
            return;
          }
          rows.push(...((page ?? []) as LockFileRow[]));
        }
        if (!mounted) return;
        setState({ key, rows });
      } catch (e) {
        if (!mounted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [client, key]);

  const data = state !== null && state.key === key ? state.rows : null;
  const loading = data === null && error === null;
  return { data, loading, error };
}
