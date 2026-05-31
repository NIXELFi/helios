import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version, VersionId } from "./types";
import { fetchAllRows } from "./paginate";

/**
 * Fetches the latest version row for each file, given the files'
 * `latest_version_id` pointers. Returns a Map keyed by file_id.
 *
 * This fetches each file's latest version DIRECTLY by id (one row per file)
 * instead of pulling every version of every file and bucketing for the max —
 * the old approach scanned a vault's entire version history (thousands of rows
 * for a vault with years of check-ins) just to find the latest of each, which
 * made the file list's actions (which need `latestSha`) take a long time to
 * appear. Fetching by the denormalized `latest_version_id` is O(files), not
 * O(all versions).
 *
 * Still chunked (PostgREST puts IN values in the URL; thousands of UUIDs blow
 * the gateway limit) and paginated (1000-row cap) per chunk.
 */
const ID_CHUNK = 200;

export function useLatestVersions(latestVersionIds: VersionId[]) {
  const client = useSupabaseClient();
  const [data, setData] = useState<Map<FileId, Version>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Serialize the id set so useEffect deps stay stable across renders.
  const sortedKey = [...latestVersionIds].sort().join(",");

  useEffect(() => {
    if (latestVersionIds.length === 0) {
      setData(new Map());
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const map = new Map<FileId, Version>();
      for (let i = 0; i < latestVersionIds.length; i += ID_CHUNK) {
        const slice = latestVersionIds.slice(i, i + ID_CHUNK);
        const { rows, error: err } = await fetchAllRows<Version>(
          () => (client.from("versions") as any).select("*").in("id", slice),
        );
        if (!mounted) return;
        if (err) {
          setError(err);
          setData(new Map());
          setLoading(false);
          return;
        }
        // Each id is unique → exactly one row per file; key by file_id.
        for (const v of rows) map.set(v.file_id, v);
      }
      setData(map);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sortedKey, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
