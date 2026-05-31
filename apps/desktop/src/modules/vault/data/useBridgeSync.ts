import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSession, useUser } from "@helios/auth";
import { loadConnection } from "../../../auth/connection";
import { localDestPath } from "./folder-paths";
import type { Folder, Lock, VaultFile, Version } from "./types";

/**
 * Pushes the current Supabase session + a snapshot of the vault into the Rust
 * "bridge" (the loopback API the SOLIDWORKS add-in calls). See
 * `apps/desktop/src-tauri/src/bridge/`.
 *
 * Why push instead of letting Rust query: the bridge must answer the add-in even
 * while Helios is minimized in the tray, where the webview's timers are
 * throttled. By keeping Rust fed with the latest session + snapshot, the
 * metadata endpoints (status / versions / checkout) resolve `?path=` and read
 * lock/version state natively, without waking the UI. The frontend stays the one
 * source of truth for auth (it owns sign-in + token refresh; it just hands Rust
 * the current token on every change).
 *
 * Mounted in the vault browse screen, where the whole-vault file/folder/lock/
 * version data is already assembled.
 *
 * NOTE (Phase 2): the snapshot is only refreshed while this screen is mounted.
 * Rust keeps the last snapshot it was given, so the add-in still works if the
 * user navigates away — it just won't reflect changes made on another screen
 * until they return. A follow-up can hoist this to an always-mounted host.
 */
export function useBridgeSync(input: {
  files: VaultFile[] | null | undefined;
  folders: Folder[] | null | undefined;
  locks: Lock[] | null | undefined;
  versionsByFileId: Map<string, Version[]>;
  vaultRoot: string | null;
}): void {
  const { files, folders, locks, versionsByFileId, vaultRoot } = input;
  const session = useSession();
  const user = useUser();

  // Push (or clear) the session whenever auth changes. onAuthStateChange-driven
  // session updates include token refreshes, so Rust never holds a stale JWT.
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

  // Build + push the vault snapshot. JSON-diff against the last push so an
  // identical snapshot (re-render with unchanged data) doesn't spam IPC.
  const lastPush = useRef<string>("");
  useEffect(() => {
    const myId = user?.id ?? null;
    const activeLockByFile = new Map<string, Lock>();
    for (const l of locks ?? []) {
      if (!l.released_at) activeLockByFile.set(l.file_id, l);
    }
    const snapFiles =
      vaultRoot && files && folders
        ? files.map((f) => {
            const ver = versionsByFileId.get(f.id)?.[0] ?? null;
            const lock = activeLockByFile.get(f.id) ?? null;
            return {
              fileId: f.id,
              localPath: localDestPath(vaultRoot, f.folder_id, f.name, folders),
              name: f.name,
              latest: ver
                ? { versionNum: ver.version_num, sha256: ver.sha256, revision: ver.revision }
                : null,
              lock: lock ? { userId: lock.user_id, byMe: lock.user_id === myId } : null,
            };
          })
        : [];
    const snapshot = { vaultRoot: vaultRoot ?? null, files: snapFiles };
    const json = JSON.stringify(snapshot);
    if (json === lastPush.current) return;
    lastPush.current = json;
    void invoke("bridge_set_snapshot", { snapshot }).catch(() => {});
  }, [files, folders, locks, versionsByFileId, vaultRoot, user?.id]);
}
