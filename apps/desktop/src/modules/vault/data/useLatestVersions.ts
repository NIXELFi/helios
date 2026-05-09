import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";

/**
 * Fetches the latest version row for every file via a single PostgREST query.
 * Returns Map<FileId, Version> — one entry per file (the highest version_num).
 */
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
      const { data: rows, error: err } = await (client.from("versions") as any)
        .select("*")
        .in("file_id", fileIds)
        .order("version_num", { ascending: false });
      if (!mounted) return;
      if (err) {
        setError(new Error(err.message ?? String(err)));
        setLoading(false);
        return;
      }
      const map = new Map<FileId, Version>();
      for (const v of rows ?? []) {
        if (!map.has(v.file_id)) map.set(v.file_id, v);
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
