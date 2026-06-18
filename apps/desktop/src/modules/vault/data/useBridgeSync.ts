import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSession, useSupabaseClientOrNull, useUser } from "@helios/auth";
import { loadConnection } from "../../../auth/connection";
import { sanitizePathSegment } from "./folder-paths";
import { sanitizeVaultName, useVaultFolder } from "./useVaultFolder";
import { fetchAllRows } from "./paginate";
import { subscribeLockChanges } from "./lock-events";
import { useInterval } from "./useInterval";
import type { Folder, Lock, Vault, VaultFile } from "./types";

/**
 * Feeds the SOLIDWORKS add-in bridge (apps/desktop/src-tauri/src/bridge/): the
 * current Supabase session + a snapshot of EVERY vault the user can access, so
 * the localhost API can answer status / versions / checkout for a file open in
 * SOLIDWORKS no matter which vault it belongs to — even while Helios is
 * minimized in the tray.
 *
 * Self-fetching (no props) and mounted once in the Shell, so it stays current
 * across every module and right after launch.
 *
 * PERFORMANCE (this is mounted app-wide and runs on lock changes, so it must
 * never block the main thread):
 *   - Path resolution is the expensive part (one path per file across all
 *     vaults). It's memoized on the structural inputs (files/folders/vaults/root)
 *     and uses an O(1) folder-id map with a depth guard — NOT the O(folders)
 *     recursive scan, which froze the UI on check-out when run over 13k+ files.
 *   - The snapshot push is debounced and only merges lock state onto the
 *     memoized paths, so a check-out (which fires a lock change) does cheap work
 *     off the click path instead of rebuilding every path synchronously.
 *   - The heavy all-files fetch runs on a slow interval; locks (which change on
 *     every check-in/out) refresh on a fast, cheap interval + the in-app bus.
 */
const FILES_REFRESH_MS = 300_000; // 5 min — files/folders/vaults change rarely
const LOCKS_REFRESH_MS = 30_000; // 30 s — locks change on every check-in/out

/** Slash-joined folder path via an O(1) id→folder map, with a depth guard so a
 *  malformed parent_id cycle can't stack-overflow (we run this over every
 *  vault's folders at once). */
/** Fire a bridge IPC command without ever throwing or rejecting. `invoke` can
 *  throw *synchronously* when the Tauri internals aren't present (non-Tauri
 *  contexts such as tests), so a plain `.catch()` isn't enough — we also need a
 *  try/catch around the call itself. The bridge is best-effort by design. */
function safeInvoke(cmd: string, args?: Record<string, unknown>): void {
  try {
    void invoke(cmd, args).catch(() => {});
  } catch {
    // Tauri internals absent — ignore (the add-in just won't get this update).
  }
}

// After a failed reload, skip this many interval ticks before retrying so a
// persistent error (network down, RLS denial) doesn't hammer Supabase.
const SKIP_AFTER_ERROR = 4;

/** Detect an expired/invalid-token failure. fetchAllRows flattens the PostgREST
 *  error to its message, so we match the auth-failure messages (JWT expired /
 *  invalid credentials / PGRST301) rather than an HTTP status code. */
function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return msg.includes("jwt expired") || msg.includes("invalid authentication") ||
    msg.includes("invalid jwt") || msg.includes("pgrst301") || msg.includes("token is expired");
}

function folderSub(folderId: string | null, byId: Map<string, Folder>, depth = 0): string {
  if (!folderId || depth > 256) return "";
  const f = byId.get(folderId);
  if (!f) return "";
  const parent = folderSub(f.parent_id, byId, depth + 1);
  const name = sanitizePathSegment(f.name);
  return parent ? `${parent}/${name}` : name;
}

export function useBridgeSync(): void {
  const client = useSupabaseClientOrNull();
  const session = useSession();
  const user = useUser();
  const { root } = useVaultFolder({ vaultName: null });

  // Push (or clear) the session on auth change — including token refresh.
  useEffect(() => {
    if (!session?.access_token || !user) {
      safeInvoke("bridge_clear_session");
      return;
    }
    const conn = loadConnection();
    if (!conn) return;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const displayName =
      (meta.display_name as string | undefined) ??
      (meta.full_name as string | undefined) ??
      (meta.name as string | undefined) ??
      user.email ??
      null;
    safeInvoke("bridge_set_session", {
      session: {
        supabaseUrl: conn.url,
        anonKey: conn.anonKey,
        accessToken: session.access_token,
        userId: user.id,
        displayName,
        email: user.email ?? null,
      },
    });
  }, [session?.access_token, user?.id, user]);

  // Cross-vault data, fetched directly (not the per-vault hooks).
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [locks, setLocks] = useState<Lock[]>([]);

  // Failure backoff: after a failed reload, skip the next SKIP_AFTER_ERROR
  // interval ticks before trying again, so a persistent error (network down,
  // RLS denial) doesn't hammer Supabase every interval. `skipTicks` is consumed
  // by the interval gate below and reset to 0 on any success. A ref (not state)
  // so updating it never re-renders this app-wide hook.
  const skipTicks = useRef(0);
  // Guards a single in-flight token refresh so concurrent failing loaders don't
  // each kick off their own refresh.
  const refreshing = useRef(false);

  // On an auth failure, refresh the session ONCE (the auth provider pushes the
  // new token via the session effect above and re-runs the loaders) instead of
  // blindly re-pulling the whole catalog with a dead token. Best-effort: any
  // failure just leaves the backoff in place until the next attempt.
  const refreshSession = useCallback(() => {
    if (refreshing.current || !client) return;
    refreshing.current = true;
    void (async () => {
      try {
        await (client as any).auth?.refreshSession?.();
      } catch (e) {
        console.error("useBridgeSync: session refresh failed", e);
      } finally {
        refreshing.current = false;
      }
    })();
  }, [client]);

  // Both loaders are best-effort and called from several places (initial mount,
  // lock-change bus, intervals) — they must never reject, or an unfed bridge
  // turns into an unhandled rejection. On failure we log, arm the backoff, and
  // (for an auth failure) trigger a session refresh.
  const onReloadError = useCallback((label: string, e: unknown) => {
    console.error(`useBridgeSync: failed to reload ${label}`, e);
    skipTicks.current = SKIP_AFTER_ERROR;
    if (isAuthError(e)) refreshSession();
  }, [refreshSession]);

  const reloadLocks = useCallback(async () => {
    if (!client) return;
    try {
      const { rows, error } = await fetchAllRows<Lock>(
        () => (client.from("locks") as any)
          .select("*")
          .is("released_at", null)
          .order("id", { ascending: true }),
      );
      if (error) throw error;
      setLocks(rows);
      skipTicks.current = 0;
    } catch (e) {
      onReloadError("locks", e);
    }
  }, [client, onReloadError]);

  const reloadStructure = useCallback(async () => {
    if (!client) return;
    try {
      const [v, f, fo] = await Promise.all([
        fetchAllRows<Vault>(() => (client.from("vaults") as any)
          .select("id,name").order("id", { ascending: true })),
        fetchAllRows<VaultFile>(() => (client.from("files") as any)
          .select("id,vault_id,folder_id,name,latest_version_id").order("id", { ascending: true })),
        fetchAllRows<Folder>(() => (client.from("folders") as any)
          .select("id,vault_id,parent_id,name").order("id", { ascending: true })),
      ]);
      // fetchAllRows resolves with an error field rather than rejecting — surface
      // the first sub-error so the backoff/refresh path runs.
      const firstErr = v.error ?? f.error ?? fo.error;
      if (firstErr) throw firstErr;
      setVaults(v.rows);
      setFiles(f.rows);
      setFolders(fo.rows);
      skipTicks.current = 0;
    } catch (e) {
      onReloadError("vault structure", e);
    }
  }, [client, onReloadError]);

  // Is the SOLIDWORKS add-in currently connected? The bridge snapshot (and its
  // locks) are consumed ONLY by the add-in, so with no add-in we skip the
  // periodic Supabase pulls entirely — that's where the idle-session egress
  // went. `invoke` can throw synchronously off Tauri (tests); treat any failure
  // as "not connected".
  const addinActive = useCallback(async (): Promise<boolean> => {
    try {
      return (await invoke("bridge_addin_active")) === true;
    } catch {
      return false;
    }
  }, []);

  // Re-fetch on sign-in (user?.id), not only on mount: the first mount can fire
  // BEFORE the session is restored from storage, so the queries return 0 rows
  // under RLS. Gated on the add-in being connected — with no add-in there's
  // nothing to feed, and a (re)connect fires an immediate refresh via the event
  // below, so the snapshot still populates the moment it's needed.
  useEffect(() => {
    void (async () => {
      if (await addinActive()) {
        void reloadStructure();
        void reloadLocks();
      }
    })();
  }, [reloadStructure, reloadLocks, addinActive, user?.id]);

  // The bridge asks for an immediate snapshot the moment the add-in (re)connects
  // (see the guard in bridge/server.rs), so it never waits a whole interval for
  // data after SOLIDWORKS opens.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const un = await listen("bridge://addin-connected", () => {
          void reloadStructure();
          void reloadLocks();
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        // Not running under Tauri (tests) — no event channel.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reloadStructure, reloadLocks]);

  useEffect(() => subscribeLockChanges(() => { void reloadLocks(); }), [reloadLocks]);

  // Periodic refreshes, but only while the add-in is connected — an idle session
  // (no SOLIDWORKS) does zero bridge network traffic. The cheap addinActive()
  // check is a local IPC call, not a network request. After a failed reload the
  // backoff (skipTicks) elapses a few ticks before retrying, shared across both
  // intervals so a persistent error doesn't hammer Supabase every cycle.
  const backoffElapsed = useCallback((): boolean => {
    if (skipTicks.current > 0) { skipTicks.current -= 1; return false; }
    return true;
  }, []);
  useInterval(
    () => void (async () => { if (backoffElapsed() && await addinActive()) void reloadStructure(); })(),
    client ? FILES_REFRESH_MS : null,
  );
  useInterval(
    () => void (async () => { if (backoffElapsed() && await addinActive()) void reloadLocks(); })(),
    client ? LOCKS_REFRESH_MS : null,
  );

  // Expensive path resolution, memoized on the structural inputs only — so a
  // lock change (frequent) does NOT recompute every path.
  const built = useMemo(() => {
    if (!root) return null;
    const cleanRoot = root.replace(/[\\/]+$/, "");
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const nameByVault = new Map(vaults.map((v) => [v.id, v.name]));
    const base = files.flatMap((f) => {
      const vaultName = nameByVault.get(f.vault_id);
      if (!vaultName) return [];
      const vaultRoot = `${cleanRoot}/${sanitizeVaultName(vaultName)}`;
      const sub = folderSub(f.folder_id, folderById);
      const fileName = sanitizePathSegment(f.name);
      const localPath = sub ? `${vaultRoot}/${sub}/${fileName}` : `${vaultRoot}/${fileName}`;
      return [{
        fileId: f.id,
        vaultName,
        localPath,
        name: f.name,
        latestVersionId: f.latest_version_id ?? null,
      }];
    });
    return { cleanRoot, base };
  }, [files, folders, vaults, root]);

  // Merge lock state onto the memoized paths and push — debounced, off the
  // synchronous lock-change/click path. JSON-diffed so an identical snapshot
  // doesn't re-cross the IPC boundary.
  const lastPush = useRef<string>("");
  useEffect(() => {
    if (!built) return;
    const handle = setTimeout(() => {
      const lockByFile = new Map<string, Lock>();
      for (const l of locks) if (!l.released_at) lockByFile.set(l.file_id, l);
      const myId = user?.id ?? null;
      const snapFiles = built.base.map((b) => {
        const lock = lockByFile.get(b.fileId) ?? null;
        return {
          ...b,
          lock: lock ? { userId: lock.user_id, byMe: lock.user_id === myId } : null,
        };
      });
      const snapshot = { vaultRoot: built.cleanRoot, files: snapFiles };
      const json = JSON.stringify(snapshot);
      if (json === lastPush.current) return;
      lastPush.current = json;
      safeInvoke("bridge_set_snapshot", { snapshot });
    }, 400);
    return () => clearTimeout(handle);
  }, [built, locks, user?.id]);
}
