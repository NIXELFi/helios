import { useEffect, useId, useRef } from "react";
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
    // The supabase-js postgres_changes payload is forwarded so callers can apply
    // the change incrementally (FULL replica identity → full new/old row). Typed
    // as unknown here to keep this hook dependency-light; callers cast to the
    // RowEvent shape from apply-events.ts.
    onVersion?: (payload?: unknown) => void;
    onLock?: (payload?: unknown) => void;
    onFile?: (payload?: unknown) => void;
  },
) {
  const client = useSupabaseClient();

  // Keep the callbacks in a ref so inline arrow functions from callers
  // don't tear down + recreate the realtime channel on every render. The
  // subscription only needs to be (re)built when client or vaultId change.
  // The ref must be updated in an effect, not during render — mutating a ref
  // during render violates React's purity model and can land an intermediate
  // value into the ref if a render is discarded (concurrent rendering).
  const cbRef = useRef(cb);
  useEffect(() => { cbRef.current = cb; });

  // Per-hook-instance suffix. Supabase realtime topics are keyed by name, so
  // two subscribers using the same `vault:<id>` name would collide on one
  // shared topic — events meant for one could be misrouted, and tearing one
  // down can drop the other. A stable, instance-unique id keeps each hook's
  // channel distinct even when several components subscribe to the same vault.
  const instanceId = useId();

  useEffect(() => {
    if (!vaultId) return;
    // Some test mocks omit the realtime API; bail quietly so the surrounding
    // UI keeps working without realtime events.
    if (typeof (client as { channel?: unknown }).channel !== "function") return;

    // Reconnect backoff. CHANNEL_ERROR / TIMED_OUT mean the socket dropped or
    // the join stalled; we rebuild the channel after a short delay. Capped so
    // a persistently-down realtime endpoint doesn't hammer reconnects.
    const BASE_BACKOFF_MS = 5000;
    const MAX_BACKOFF_MS = 30000;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let current: ReturnType<typeof client.channel> | null = null;
    let disposed = false;

    const teardown = () => {
      if (current) {
        client.removeChannel(current);
        current = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      teardown();
      current = client
        .channel(`vault:${vaultId}:${instanceId}`)
        .on("postgres_changes", { event: "*", schema: "pdm", table: "versions" }, (payload) => cbRef.current.onVersion?.(payload))
        .on("postgres_changes", { event: "*", schema: "pdm", table: "locks" }, (payload) => cbRef.current.onLock?.(payload))
        .on("postgres_changes", { event: "*", schema: "pdm", table: "files" }, (payload) => cbRef.current.onFile?.(payload))
        .subscribe((status: string, err?: unknown) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            attempt = 0; // healthy join — reset backoff.
            return;
          }
          // Anything else is noteworthy; log it for field debugging.
          console.warn(`[vault realtime] channel ${vaultId} status: ${status}`, err ?? "");
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            if (reconnectTimer) return; // a reconnect is already pending.
            const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
            attempt++;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, delay);
          }
        });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      teardown();
    };
  }, [client, vaultId, instanceId]);
}
