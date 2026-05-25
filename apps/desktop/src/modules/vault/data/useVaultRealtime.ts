import { useEffect, useRef } from "react";
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

  // Keep the callbacks in a ref so inline arrow functions from callers
  // don't tear down + recreate the realtime channel on every render. The
  // subscription only needs to be (re)built when client or vaultId change.
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    if (!vaultId) return;
    // Some test mocks omit the realtime API; bail quietly so the surrounding
    // UI keeps working without realtime events.
    if (typeof (client as { channel?: unknown }).channel !== "function") return;
    const channel = client
      .channel(`vault:${vaultId}`)
      .on("postgres_changes", { event: "*", schema: "pdm", table: "versions" }, () => cbRef.current.onVersion?.())
      .on("postgres_changes", { event: "*", schema: "pdm", table: "locks" }, () => cbRef.current.onLock?.())
      .on("postgres_changes", { event: "*", schema: "pdm", table: "files" }, () => cbRef.current.onFile?.())
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [client, vaultId]);
}
