import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
      void invoke("bridge_clear_session").catch(() => {});
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
    void invoke("bridge_set_session", {
      session: {
        supabaseUrl: conn.url,
        anonKey: conn.anonKey,
        accessToken: session.access_token,
        userId: user.id,
        displayName,
        email: user.email ?? null,
      },
    }).catch(() => {});
  }, [session?.access_token, user?.id, user]);

  // Cross-vault data, fetched directly (not the per-vault hooks).
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [locks, setLocks] = useState<Lock[]>([]);

  const reloadLocks = useCallback(async () => {
    if (!client) return;
    const { rows } = await fetchAllRows<Lock>(
      () => (client.from("locks") as any)
        .select("*")
        .is("released_at", null)
        .order("id", { ascending: true }),
    );
    setLocks(rows);
  }, [client]);

  const reloadStructure = useCallback(async () => {
    if (!client) return;
    const [v, f, fo] = await Promise.all([
      fetchAllRows<Vault>(() => (client.from("vaults") as any)
        .select("id,name").order("id", { ascending: true })),
      fetchAllRows<VaultFile>(() => (client.from("files") as any)
        .select("id,vault_id,folder_id,name,latest_version_id").order("id", { ascending: true })),
      fetchAllRows<Folder>(() => (client.from("folders") as any)
        .select("id,vault_id,parent_id,name").order("id", { ascending: true })),
    ]);
    setVaults(v.rows);
    setFiles(f.rows);
    setFolders(fo.rows);
  }, [client]);

  useEffect(() => { void reloadStructure(); void reloadLocks(); }, [reloadStructure, reloadLocks]);
  useEffect(() => subscribeLockChanges(() => { void reloadLocks(); }), [reloadLocks]);
  useInterval(reloadStructure, client ? FILES_REFRESH_MS : null);
  useInterval(reloadLocks, client ? LOCKS_REFRESH_MS : null);

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
      void invoke("bridge_set_snapshot", { snapshot }).catch(() => {});
    }, 400);
    return () => clearTimeout(handle);
  }, [built, locks, user?.id]);
}
