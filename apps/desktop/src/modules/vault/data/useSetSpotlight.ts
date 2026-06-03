import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, VaultId } from "./types";

/**
 * Sets (or clears, with `null`) a vault's spotlight file. Writes
 * `pdm.vaults.spotlight_file_id`; the vaults_update_admin RLS policy means only
 * admins succeed — non-admins get a permission error surfaced via `error`, and
 * the UI hides the control for them anyway. Caller refetches vaults on success.
 */
export function useSetSpotlight() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (vaultId: VaultId, fileId: FileId | null): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await (client.from("vaults") as any)
        .update({ spotlight_file_id: fileId })
        .eq("id", vaultId);
      setLoading(false);
      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        return false;
      }
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
