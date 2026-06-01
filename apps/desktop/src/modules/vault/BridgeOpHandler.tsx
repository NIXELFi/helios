import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import { useCheckIn } from "./data/useCheckIn";
import { useDownloadVersion } from "./data/useDownloadVersion";
import { useAddLocalFile } from "./data/useAddLocalFile";
import { useVaults } from "./data/useVaults";
import { sanitizeVaultName, useVaultFolder } from "./data/useVaultFolder";
import type { LocalFile } from "./data/useLocalFolderScan";
import type { Vault } from "./data/types";

/**
 * Runs the SOLIDWORKS add-in bridge's BLOB / write operations in the UI, where
 * the tested upload/download/add code already lives (the metadata ops — status /
 * versions / checkout — are served natively in Rust). Rust emits `bridge://op`
 * with a request id; we run the op and reply via `bridge_respond` to unblock the
 * waiting HTTP request. Mounted only when signed in (the hooks need a client).
 */
type OpPayload =
  | { id: string; op: "checkin"; fileId: string; path: string; comment: string | null }
  | { id: string; op: "getLatest"; sha: string; destPath: string }
  | { id: string; op: "add"; path: string };

/** Resolve which vault a local path belongs to (it lives at
 *  `<root>/<sanitize(vaultName)>/<relativePath>`), so an untracked file can be
 *  added to the right vault. */
function resolveVaultForPath(
  path: string,
  root: string | null,
  vaults: Vault[] | null,
): { vaultId: string; relativePath: string } | null {
  if (!root || !vaults) return null;
  const rootFwd = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const pathFwd = path.replace(/\\/g, "/");
  const lower = pathFwd.toLowerCase();
  for (const v of vaults) {
    const vroot = `${rootFwd}/${sanitizeVaultName(v.name)}`;
    if (lower.startsWith(vroot.toLowerCase() + "/")) {
      return { vaultId: v.id, relativePath: pathFwd.slice(vroot.length + 1) };
    }
  }
  return null;
}

export function BridgeOpHandler(): null {
  const checkIn = useCheckIn();
  const download = useDownloadVersion();
  const addFile = useAddLocalFile();
  const { root } = useVaultFolder({ vaultName: null });
  const { data: vaults } = useVaults();

  // The hooks return change identity on internal state sets; keep the latest in
  // refs so the once-registered listener always calls the current values.
  const checkInRef = useRef(checkIn.run);
  checkInRef.current = checkIn.run;
  const downloadRef = useRef(download.run);
  downloadRef.current = download.run;
  const addRef = useRef(addFile.run);
  addRef.current = addFile.run;
  const rootRef = useRef(root);
  rootRef.current = root;
  const vaultsRef = useRef<Vault[] | null>(vaults);
  vaultsRef.current = vaults;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void listen<OpPayload>("bridge://op", async (event) => {
      const p = event.payload;
      const respond = (result: Record<string, unknown>) =>
        void invoke("bridge_respond", { reply: { id: p.id, result } }).catch(() => {});
      try {
        if (p.op === "checkin") {
          const bytes = await readFile(p.path);
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const ver = await checkInRef.current(p.fileId, buf, p.comment ?? null);
          respond(ver
            ? { ok: true, versionNum: ver.version_num, versionId: ver.id }
            : { ok: false, error: "check-in failed" });
        } else if (p.op === "getLatest") {
          const ok = await downloadRef.current(p.sha, p.destPath);
          respond(ok ? { ok: true } : { ok: false, error: "download failed" });
        } else if (p.op === "add") {
          const resolved = resolveVaultForPath(p.path, rootRef.current, vaultsRef.current);
          if (!resolved) {
            respond({ ok: false, error: "file isn't under your Helios vault folder" });
            return;
          }
          const local: LocalFile = {
            basename: resolved.relativePath.split("/").pop() ?? resolved.relativePath,
            relativePath: resolved.relativePath,
            absolutePath: p.path,
            sha256: "", // empty → useAddLocalFile reads + hashes the file itself
            sizeBytes: 0,
          };
          const res = await addRef.current(resolved.vaultId, local);
          respond(res.ok
            ? { ok: true, lockAcquired: res.lockAcquired, alreadyExisted: res.alreadyExisted }
            : { ok: false, error: res.error });
        } else {
          respond({ ok: false, error: "unknown bridge op" });
        }
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }).then((u) => {
      if (active) unlisten = u;
      else u();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return null;
}
