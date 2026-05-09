import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FolderId, VaultFile, VaultId } from "./types";

export function useCreateFile() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (
      vault_id: VaultId,
      folder_id: FolderId | null,
      name: string,
    ): Promise<VaultFile | null> => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("files") as any)
        .insert({ vault_id, folder_id, name })
        .select()
        .single();
      setLoading(false);
      if (err) {
        setError(new Error(err.message ?? String(err)));
        return null;
      }
      return data as VaultFile;
    },
    [client],
  );

  return { run, loading, error };
}
