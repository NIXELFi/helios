import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version, VersionId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";
import { setLockOverlay } from "./lock-overlay";

/** Restore an old version as the file's new latest (SW-PDM rollback).
 *  Server-side this is a check-in of that version's content: it requires the
 *  caller's active lock and RELEASES it on success — no upload happens (the
 *  bucket is content-addressed and already holds the bytes). The old
 *  version's data card + refs are carried onto the new version. */
export function useRestoreVersion() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (file_id: FileId, version_id: VersionId): Promise<Version | null> => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.rpc("pdm_restore_version", {
        p_file_id: file_id,
        p_version_id: version_id,
      });
      setLoading(false);
      if (err) {
        setError(new Error(friendlyPgError(err, "version").message));
        return null;
      }
      // The RPC released the caller's lock — clear the pill this frame and
      // broadcast so every mounted useLocks() refetches (mirrors useCheckIn).
      setLockOverlay(file_id, { kind: "remove" });
      notifyLockChange();
      return data as Version;
    },
    [client],
  );

  return { run, loading, error };
}
