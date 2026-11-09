import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";
import { notifyVaultsChanged } from "./useVaults";

/**
 * Marks a vault archived (a previous year's car) or active again. Writes
 * `pdm.vaults.archived` through the admin-only vaults UPDATE RLS policy, then
 * tells every mounted vault list to refetch. An update RLS filters out returns
 * no error, so the row is read back to confirm the change took.
 */
export function useSetVaultArchived() {
  const client = useSupabaseClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (vaultId: VaultId, archived: boolean): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const { data, error: err } = await (client.from("vaults") as any)
          .update({ archived })
          .eq("id", vaultId)
          .select("id, archived");
        if (err) throw new Error(String(err.message ?? err));
        const row = Array.isArray(data) ? data[0] : null;
        if (!row || row.archived !== archived) {
          throw new Error("You don't have permission to change this vault.");
        }
        notifyVaultsChanged();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client],
  );

  return { run, saving, error };
}
