import { useEffect, useId, useRef } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";
import { publishVaultEvent, subscribeVaultEvents, type VaultEventTable } from "./vault-events";

const FEED_TABLES: VaultEventTable[] = ["versions", "locks", "files", "folders"];

/**
 * THE vault's realtime connection: one Supabase channel per vault, mounted once
 * (VaultHome). Every `postgres_changes` payload for the pdm tables that drive
 * the vault UI is published to the vault-events bus, and everything that used
 * to open its own channel — the file lists (useVaultRealtime) and the
 * notification feed (useNotifications) — subscribes to the bus instead.
 *
 * RLS gates which rows we receive; the subscription mirrors what the user can
 * SELECT. Cross-vault events are filtered out by the consumers via vaultId
 * checks where relevant.
 */
export function useVaultRealtimeFeed(vaultId: VaultId | undefined): void {
  const client = useSupabaseClient();

  // Per-hook-instance suffix. Supabase realtime topics are keyed by name, so
  // two feeds using the same `vault:<id>` name would collide on one shared
  // topic — events meant for one could be misrouted, and tearing one down can
  // drop the other. A stable, instance-unique id keeps each feed's channel
  // distinct even if two Vault trees are ever mounted at once.
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
      let ch = client.channel(`vault:${vaultId}:${instanceId}`);
      for (const table of FEED_TABLES) {
        ch = ch.on(
          "postgres_changes" as any,
          { event: "*", schema: "pdm", table } as any,
          (payload: unknown) => {
            if (disposed) return;
            publishVaultEvent(vaultId, table, payload);
          },
        );
      }
      current = ch.subscribe((status: string, err?: unknown) => {
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

/**
 * Subscribe to the vault's realtime events by table. Same callback API as
 * before, but the events now arrive over the in-process bus fed by
 * `useVaultRealtimeFeed` instead of a second Supabase channel of this hook's
 * own — two channels per vault were 2× the realtime subscriptions for no extra
 * information (load audit 2026-09-09, finding 10).
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
    onFolder?: (payload?: unknown) => void;
  },
) {
  // Keep the callbacks in a ref so inline arrow functions from callers don't
  // tear down + recreate the subscription on every render. The ref must be
  // updated in an effect, not during render — mutating a ref during render
  // violates React's purity model and can land an intermediate value into the
  // ref if a render is discarded (concurrent rendering).
  const cbRef = useRef(cb);
  useEffect(() => { cbRef.current = cb; });

  useEffect(() => {
    if (!vaultId) return;
    return subscribeVaultEvents(vaultId, (table, payload) => {
      const c = cbRef.current;
      if (table === "versions") c.onVersion?.(payload);
      else if (table === "locks") c.onLock?.(payload);
      else if (table === "files") c.onFile?.(payload);
      else if (table === "folders") c.onFolder?.(payload);
    });
  }, [vaultId]);
}
