/**
 * Vault notification feed hook.
 *
 * Subscribes to realtime events (via a dedicated focused subscription — not
 * bloating useVaultRealtime which is already used for file-list updates),
 * maps them through eventToNotification against the current watch set, and
 * merges results into a localStorage-persisted capped list.
 *
 * Timestamps are stamped HERE (not in the pure lib) because this module is
 * allowed to call new Date().
 *
 * Storage key: `helios.vault-notifs.<vaultId>`
 * Cap: 50 items (configurable below).
 *
 * v1 LIMITATION: Frontend-only — notifications are device-local and lost on
 * localStorage clear. Server-side fan-out (pdm.notifications table + DB trigger)
 * for cross-device / offline history is a planned follow-up.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { eventToNotification, mergeNotifications, unreadCount, type RealtimePayload } from "../lib/notifications";
import type { Notification } from "../lib/notifications";
import type { FileId, VaultId, VaultFile } from "./types";
import type { UseWatchedFiles } from "./useWatchedFiles";

const NOTIF_CAP = 50;

function storageKey(vaultId: VaultId): string {
  return `helios.vault-notifs.${vaultId}`;
}

function loadNotifs(vaultId: VaultId): Notification[] {
  try {
    const raw = localStorage.getItem(storageKey(vaultId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Notification[];
  } catch {
    // corrupt — start fresh
  }
  return [];
}

function saveNotifs(vaultId: VaultId, items: Notification[]): void {
  try {
    localStorage.setItem(storageKey(vaultId), JSON.stringify(items));
  } catch {
    // quota exceeded — ignore
  }
}

export interface UseNotifications {
  items: Notification[];
  unread: number;
  markAllRead: () => void;
  clear: () => void;
}

export function useNotifications(
  vaultId: VaultId | undefined,
  watched: UseWatchedFiles["watched"],
  /** The current file list so we can resolve fileId → name. */
  files: VaultFile[],
): UseNotifications {
  const client = useSupabaseClient();

  const [items, setItems] = useState<Notification[]>(() =>
    vaultId ? loadNotifs(vaultId) : [],
  );

  // Reload when vault changes
  useEffect(() => {
    setItems(vaultId ? loadNotifs(vaultId) : []);
  }, [vaultId]);

  // Keep watched + files in a ref so the realtime callback closure always sees
  // the latest values without needing to rebuild the subscription.
  const watchedRef = useRef(watched);
  useEffect(() => { watchedRef.current = watched; });

  const filesRef = useRef(files);
  useEffect(() => { filesRef.current = files; });

  const vaultIdRef = useRef(vaultId);
  useEffect(() => { vaultIdRef.current = vaultId; });

  // Dedicated realtime subscription for notifications — kept separate from
  // useVaultRealtime (which handles file-list updates) so neither hook adds
  // concerns to the other. Subscribes to the same 4 tables but with a
  // distinct channel name so the two don't collide.
  useEffect(() => {
    if (!vaultId) return;
    if (typeof (client as { channel?: unknown }).channel !== "function") return;

    let channel: ReturnType<typeof client.channel> | null = null;
    let disposed = false;

    function handlePayload(raw: unknown) {
      if (disposed) return;
      const payload = raw as RealtimePayload;
      const currentVaultId = vaultIdRef.current;
      if (!currentVaultId) return;

      const ctx = {
        fileNames: new Map<string, string>(
          filesRef.current.map((f) => [f.id, f.name] as [FileId, string]),
        ),
      };
      const at = new Date().toISOString();
      const notif = eventToNotification(payload, watchedRef.current, ctx, at);
      if (!notif) return;

      setItems((prev) => {
        const next = mergeNotifications(prev, [notif], NOTIF_CAP);
        saveNotifs(currentVaultId, next);
        return next;
      });
    }

    channel = client
      .channel(`vault-notifs:${vaultId}`)
      .on("postgres_changes", { event: "*", schema: "pdm", table: "versions" }, handlePayload)
      .on("postgres_changes", { event: "*", schema: "pdm", table: "locks" }, handlePayload)
      .on("postgres_changes", { event: "*", schema: "pdm", table: "files" }, handlePayload)
      .subscribe();

    return () => {
      disposed = true;
      if (channel) client.removeChannel(channel);
    };
  }, [client, vaultId]);

  const markAllRead = useCallback(() => {
    setItems((prev) => {
      if (prev.every((n) => n.read)) return prev;
      const next = prev.map((n) => ({ ...n, read: true }));
      if (vaultIdRef.current) saveNotifs(vaultIdRef.current, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    if (vaultIdRef.current) saveNotifs(vaultIdRef.current, []);
  }, []);

  return { items, unread: unreadCount(items), markAllRead, clear };
}
