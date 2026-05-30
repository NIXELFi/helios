import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, Version } from "./types";
import { friendlyPgError } from "./pg-errors";

/**
 * SW-PDM "Set Revision": stamp a numeric revision onto a file's latest version.
 * `revision` omitted/null → the server auto-assigns the next number (max + 1).
 * Editor+ only (the RPC enforces it); a failure surfaces via `error`.
 */
export function useSetRevision() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (fileId: FileId, revision?: number | null): Promise<Version | null> => {
      setLoading(true);
      setError(null);
      const { data, error: rpcErr } = await client.rpc("pdm_set_revision", {
        p_file_id: fileId,
        p_revision: revision ?? null,
      });
      setLoading(false);
      if (rpcErr) {
        setError(new Error(friendlyPgError(rpcErr, "version").message));
        return null;
      }
      return data as Version;
    },
    [client],
  );

  return { run, loading, error };
}
