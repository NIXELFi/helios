import { useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";

export interface LocalVersionPair {
  fileId: FileId;
  /** The local file's on-disk sha256 (any case; compared case-insensitively). */
  sha256: string;
}

// PostgREST encodes .in() into the URL; keep each chunk well under length
// limits. A folder view is small in practice, so this rarely exceeds one chunk.
const CHUNK = 150;

const EMPTY_MAP: Map<string, number> = new Map();

/**
 * Resolve which VAULT VERSION a locally "modified" file's on-disk sha
 * corresponds to (if any), so the UI can show "v12 of v14" instead of a bare
 * "modified" -- versionsMap only carries the LATEST version per file (it's
 * built from each file's embedded `latest` row), so an older local revision
 * can't be named from it; this hook is the extra lookup that names it.
 *
 * Callers pass only the CURRENT FOLDER's "modified" rows (fileId + local
 * sha256) -- synced rows are already at latest and vault-only rows have no
 * local file, so neither needs resolving.
 *
 * Returns a Map keyed `${fileId}:${sha256.toLowerCase()}` to version_num.
 * A missing key means the local sha doesn't match ANY known version of that
 * file (the "edited" case), or the fetch for the current file-id set hasn't
 * landed yet.
 *
 * Does ONE batched query (`versions` select, `.in("file_id", ids)`) per
 * distinct set of file ids, memoized on the sorted id list so a re-render
 * with the same rows (a new `pairs` array, same ids) does not refetch. Skips
 * the query entirely when `pairs` is empty.
 */
export function useLocalVersionNums(pairs: LocalVersionPair[]): Map<string, number> {
  const client = useSupabaseClient();
  const [state, setState] = useState<{ key: string; map: Map<string, number> }>({
    key: "",
    map: EMPTY_MAP,
  });

  // Stable identity for the (fileId, sha) set. Filtering the query by sha as
  // well as file id bounds the row count by the number of modified rows in
  // view instead of by version history depth (a folder of long-lived
  // assemblies could otherwise exceed PostgREST's 1000-row cap and silently
  // truncate). Legacy rows may store an uppercase sha, so both cases go in.
  const key = useMemo(
    () => [...new Set(pairs.map((p) => `${p.fileId}|${p.sha256.toLowerCase()}`))].sort().join(","),
    [pairs],
  );

  useEffect(() => {
    const pairsInKey = key === "" ? [] : key.split(",").map((k) => k.split("|") as [string, string]);
    const ids = [...new Set(pairsInKey.map((p) => p[0]))];
    const shas = [...new Set(pairsInKey.flatMap((p) => [p[1], p[1].toUpperCase()]))];
    if (ids.length === 0) {
      setState({ key, map: EMPTY_MAP });
      return;
    }
    let mounted = true;
    (async () => {
      const map = new Map<string, number>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        // Best-effort: a query error (or a thrown one, e.g. a partial client
        // stub in tests) just leaves those files unresolved, so the badge
        // falls back to "edited" instead of naming a version.
        let data: unknown = null;
        try {
          const res = await (client.from("versions") as any)
            .select("file_id,version_num,sha256")
            .in("file_id", chunk)
            .in("sha256", shas);
          if (res?.error) continue;
          data = res?.data;
        } catch {
          continue;
        }
        if (!mounted) return;
        for (const row of (data ?? []) as
          Array<{ file_id: string; version_num: number; sha256: string | null }>) {
          if (!row.sha256) continue;
          map.set(`${row.file_id}:${row.sha256.toLowerCase()}`, row.version_num);
        }
      }
      if (!mounted) return;
      setState({ key, map });
    })();
    return () => {
      mounted = false;
    };
  }, [client, key]);

  // While a new set is in flight keep the previous answers: rows that were
  // already resolved stay "v12 of v14" instead of flashing to "edited".
  return state.map;
}

/** Build the lookup key for a (fileId, sha256) pair, matching the map this
 *  hook returns. Exported so callers don't hand-roll the ":"-join + case fold. */
export function localVersionKey(fileId: FileId, sha256: string): string {
  return `${fileId}:${sha256.toLowerCase()}`;
}
