import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { FileId, Lock } from "./types";

export function useAcquireLock() {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<Lock | null>(null);

  const run = useCallback(
    async (file_id: FileId): Promise<Lock | null> => {
      if (!user) {
        const e = new Error("not authenticated");
        setError(e);
        return null;
      }
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("locks") as any)
        .insert({ file_id, user_id: user.id })
        .select()
        .single();
      setLoading(false);
      if (err) {
        const e = new Error(err.message ?? String(err));
        setError(e);
        return null;
      }
      setResult(data);
      return data;
    },
    [client, user],
  );

  return { run, loading, error, result };
}
