import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSession, useSupabaseClientOrNull, useUser } from "@helios/auth";
import { loadConnection } from "../../../auth/connection";
import { localDestPath } from "./folder-paths";
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
 * Multi-vault is the whole point: Helios is multi-vault (SDM26, SDM27, …) and a
 * file open in SOLIDWORKS could be from any of them. An earlier version snapshotted
 * only the *active* vault, so files from other vaults were wrongly reported as
 * "not tracked". This fetches across all vaults the user can see (RLS-scoped) and
 * resolves each file's local path under the shared root: `<root>/<vaultName>/…`.
 *
 * Self-fetching (no props) and mounted once in VaultHome, so it stays current
 * regardless of which vault/screen is active. Data is reloaded on mount, on a
 * slow interval, and locks promptly on any in-app lock change.
 */
const REFRESH_MS = 60_000;

type SnapFile = {
  fileId: string;
  vaultName: string;
  localPath: string;
  name: string;
  /** The file's latest-version id, so the bridge can look up version/sha on
   *  demand (kept lean — we don't ship every version row in the snapshot). */
  latestVersionId: string | null;
  lock: { userId: string; byMe: boolean } | null;
};

export function useBridgeSync(): void {
  const client = useSupabaseClientOrNull();
  const session = useSession();
  const user = useUser();
  // One shared local root; each vault lives at `<root>/<vaultName>`.
  const { root } = useVaultFolder({ vaultName: null });

  // Push (or clear) the session on auth change — including token refresh, so
  // Rust never holds a stale JWT.
  useEffect(() => {
    if (!session?.access_token || !user) {
      void invoke("bridge_clear_session").catch(() => {});
      return;
    }
    const conn = loadConnection();
    if (!conn) return;
    void invoke("bridge_set_session", {
      session: {
        supabaseUrl: conn.url,
        anonKey: conn.anonKey,
        accessToken: session.access_token,
        userId: user.id,
      },
    }).catch(() => {});
  }, [session?.access_token, user?.id, user]);

  // Cross-vault data. We query the tables directly (not the per-vault hooks) so
  // a single set of fetches covers every vault.
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

  const reloadAll = useCallback(async () => {
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
    await reloadLocks();
  }, [client, reloadLocks]);

  useEffect(() => { void reloadAll(); }, [reloadAll]);
  useEffect(() => subscribeLockChanges(() => { void reloadLocks(); }), [reloadLocks]);
  useInterval(reloadAll, client ? REFRESH_MS : null);

  // Build + push the snapshot. JSON-diffed so an identical snapshot doesn't
  // re-cross the IPC boundary.
  const lastPush = useRef<string>("");
  useEffect(() => {
    if (!root) return;
    const nameByVault = new Map(vaults.map((v) => [v.id, v.name]));
    const activeLockByFile = new Map<string, Lock>();
    for (const l of locks) if (!l.released_at) activeLockByFile.set(l.file_id, l);
    const myId = user?.id ?? null;
    const cleanRoot = root.replace(/[\\/]+$/, "");

    const snapFiles: SnapFile[] = [];
    for (const f of files) {
      const vaultName = nameByVault.get(f.vault_id);
      if (!vaultName) continue; // a vault we can't name → skip (can't resolve path)
      const vaultRoot = `${cleanRoot}/${sanitizeVaultName(vaultName)}`;
      const lock = activeLockByFile.get(f.id) ?? null;
      snapFiles.push({
        fileId: f.id,
        vaultName,
        localPath: localDestPath(vaultRoot, f.folder_id, f.name, folders),
        name: f.name,
        latestVersionId: f.latest_version_id ?? null,
        lock: lock ? { userId: lock.user_id, byMe: lock.user_id === myId } : null,
      });
    }
    const snapshot = { vaultRoot: cleanRoot, files: snapFiles };
    const json = JSON.stringify(snapshot);
    if (json === lastPush.current) return;
    lastPush.current = json;
    void invoke("bridge_set_snapshot", { snapshot }).catch(() => {});
  }, [files, folders, vaults, locks, root, user?.id]);
}
