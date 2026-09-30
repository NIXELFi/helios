/**
 * Vault notification feed hook.
 *
 * Reads the vault's realtime events off the shared vault-events bus (fed by the
 * single channel in VaultHome — this hook used to open a SECOND Supabase
 * channel per vault, which the 2026-09-09 load audit confirmed live in prod),
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
import { subscribeVaultEvents } from "./vault-events";
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

  // Notification subscription over the shared bus. The feed in VaultHome owns
  // the one channel per vault; this hook sees exactly the payloads it saw
  // before (versions / locks / files — folder events never produced a
  // notification, so they are filtered out here).
  useEffect(() => {
    if (!vaultId) return;

    function handlePayload(raw: unknown) {
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

    return subscribeVaultEvents(vaultId, (table, payload) => {
      if (table === "folders") return;
      handlePayload(payload);
    });
  }, [vaultId]);

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
