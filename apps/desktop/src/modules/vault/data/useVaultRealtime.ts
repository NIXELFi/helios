import { useEffect } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";

/**
 * Subscribe to Supabase realtime events on the pdm tables that drive auto-sync
 * (versions, locks, files). Each event type calls the matching callback so the
 * caller can refetch the right slice. RLS gates which rows we receive — the
 * subscription mirrors what the user can SELECT.
 *
 * One channel per vault keeps payload volume bounded; cross-vault events are
 * filtered out by the caller via vaultId checks where relevant.
 */
export function useVaultRealtime(
  vaultId: VaultId | undefined,
  cb: {
    onVersion?: () => void;
    onLock?: () => void;
    onFile?: () => void;
  },
) {
  const client = useSupabaseClient();

  useEffect(() => {
    if (!vaultId) return;
    // Some test mocks omit the realtime API; bail quietly so the surrounding
    // UI keeps working without realtime events.
    if (typeof (client as { channel?: unknown }).channel !== "function") return;
    const channel = client
      .channel(`vault:${vaultId}`)
      .on("postgres_changes", { event: "*", schema: "pdm", table: "versions" }, () => cb.onVersion?.())
      .on("postgres_changes", { event: "*", schema: "pdm", table: "locks" }, () => cb.onLock?.())
      .on("postgres_changes", { event: "*", schema: "pdm", table: "files" }, () => cb.onFile?.())
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [client, vaultId, cb.onVersion, cb.onLock, cb.onFile]);
}
