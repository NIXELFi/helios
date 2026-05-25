import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";
import { fetchAllRows } from "./paginate";

/**
 * Fetches the latest version row for every file in fileIds.
 *
 * Two reasons this needs to be smarter than a single .in("file_id", …) call:
 *  (1) PostgREST caps responses at 1000 rows by default — paginate via range.
 *  (2) PostgREST puts the IN-clause values in the URL query string. With
 *      thousands of UUIDs the URL blows past gateway limits and the request
 *      either fails or gets silently truncated.
 *
 * Strategy: chunk the file id set into batches of ~200 and paginate each.
 * Then bucket by file_id and keep the highest version_num seen.
 */
const ID_CHUNK = 200;

export function useLatestVersions(fileIds: FileId[]) {
  const client = useSupabaseClient();
  const [data, setData] = useState<Map<FileId, Version>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  // Serialize the file-id set so useEffect deps stay stable.
  const sortedKey = [...fileIds].sort().join(",");

  useEffect(() => {
    if (fileIds.length === 0) {
      setData(new Map());
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const all: Version[] = [];
      for (let i = 0; i < fileIds.length; i += ID_CHUNK) {
        const slice = fileIds.slice(i, i + ID_CHUNK);
        const { rows, error: err } = await fetchAllRows<Version>(
          () => (client.from("versions") as any)
            .select("*")
            .in("file_id", slice)
            .order("version_num", { ascending: false }),
        );
        if (!mounted) return;
        if (err) {
          setError(err);
          // Drop any partially-populated map so consumers don't render
          // half-stale data alongside the error.
          setData(new Map());
          setLoading(false);
          return;
        }
        all.push(...rows);
      }
      const map = new Map<FileId, Version>();
      for (const v of all) {
        const prev = map.get(v.file_id);
        if (!prev || v.version_num > prev.version_num) map.set(v.file_id, v);
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
