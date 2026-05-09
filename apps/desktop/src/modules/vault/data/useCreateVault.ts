import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { Vault } from "./types";

export function useCreateVault() {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (name: string): Promise<Vault | null> => {
      if (!user) {
        setError(new Error("not authenticated"));
        return null;
      }
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("vaults") as any)
        .insert({ name, created_by: user.id })
        .select()
        .single();
      setLoading(false);
      if (err) {
        setError(new Error(err.message ?? String(err)));
        return null;
      }
      return data as Vault;
    },
    [client, user],
  );

  return { run, loading, error };
}
