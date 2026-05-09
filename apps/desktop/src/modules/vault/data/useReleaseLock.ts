import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";

export function useReleaseLock() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (file_id: FileId): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_cancel_checkout", {
        p_file_id: file_id,
      });
      setLoading(false);
      if (err) {
        setError(new Error(err.message ?? String(err)));
        return false;
      }
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
