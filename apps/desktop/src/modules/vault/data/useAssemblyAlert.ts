import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, VaultId } from "./types";

export interface AssemblyAlert {
  enabled: boolean;
  file_id: FileId | null;
  file_name: string | null;
  /** The webhook URL itself never leaves the server, only whether one is set. */
  has_webhook: boolean;
}

export interface AssemblyAlertInput {
  enabled: boolean;
  fileId: FileId | null;
  /** Empty keeps the webhook already saved. */
  webhookUrl: string;
}

/** Per-vault master-assembly Slack alert settings. Both RPCs are vault-admin only. */
export function useAssemblyAlert(vaultId: VaultId) {
  const client = useSupabaseClient();
  const [data, setData] = useState<AssemblyAlert | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    const { data: rows, error } = await client.rpc("assembly_alert_get", { p_vault_id: vaultId });
    if (error) throw new Error(String(error.message ?? error));
    return ((rows ?? [])[0] ?? null) as AssemblyAlert | null;
  }, [client, vaultId]);

  useEffect(() => {
    let mounted = true;
    setData(null);
    setLoadError(null);
    load().then(
      (row) => { if (mounted) setData(row); },
      (e: Error) => { if (mounted) setLoadError(e); },
    );
    return () => {
      mounted = false;
    };
  }, [load]);

  const save = useCallback(
    async ({ enabled, fileId, webhookUrl }: AssemblyAlertInput): Promise<boolean> => {
      setSaving(true);
      setSaveError(null);
      const { error } = await client.rpc("assembly_alert_set", {
        p_vault_id: vaultId,
        p_enabled: enabled,
        p_file_id: fileId,
        p_webhook_url: webhookUrl.trim() || null,
      });
      if (error) {
        setSaving(false);
        setSaveError(new Error(String(error.message ?? error)));
        return false;
      }
      try {
        setData(await load());
      } catch (e) {
        setSaveError(e instanceof Error ? e : new Error(String(e)));
      }
      setSaving(false);
      return true;
    },
    [client, vaultId, load],
  );

  return { data, loadError, saving, saveError, save };
}
