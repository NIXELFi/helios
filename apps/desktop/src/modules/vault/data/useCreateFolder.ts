import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, FolderId, VaultId } from "./types";
import { friendlyPgError } from "./pg-errors";

export function useCreateFolder() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (
      vault_id: VaultId,
      name: string,
      parent_id: FolderId | null = null,
    ): Promise<Folder | null> => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("folders") as any)
        .insert({ vault_id, name, parent_id })
        .select()
        .single();
      setLoading(false);
      if (err) {
        setError(new Error(friendlyPgError(err, "folder").message));
        return null;
      }
      return data as Folder;
    },
    [client],
  );

  return { run, loading, error };
}
