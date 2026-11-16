import { mkdir } from "@tauri-apps/plugin-fs";
import type { Folder } from "./types";
import { folderPath } from "./folder-paths";

/** Every live folder's local absolute path, deepest paths included (mkdir
 *  recursive makes parents, so we only need leaf-most coverage — but emitting
 *  all is simpler and idempotent). Pure; exported for tests. */
export function localFolderPaths(folders: Folder[], vaultRoot: string): string[] {
  return folders
    .map((f) => folderPath(f.id, folders))
    .filter((p) => p !== "")
    .map((p) => `${vaultRoot}/${p}`);
}

/** Materialize the vault's folder tree under vaultRoot. Both download modes
 *  call this so the scaffolding always exists locally, even for empty
 *  folders. Idempotent + best-effort: an EEXIST or permission failure on one
 *  dir never blocks the others. */
/**
 * Folder lists recently materialized, by array identity → root + time. Every
 * auto-sync pass (2–4 per added file, since each realtime event re-triggers
 * one) and every folder-list change called this, and each call is one
 * sequential `mkdir` per folder — 388 for SDM27 — on the Tauri MAIN thread
 * (plugin-fs runs `mkdir` synchronously there), queueing every other fs call
 * and the UI behind it. An unchanged list for the same root is skipped for
 * REMATERIALIZE_MS; after that a locally-deleted empty folder is recreated as
 * before.
 */
const materialized = new WeakMap<Folder[], { root: string; at: number }>();
export const REMATERIALIZE_MS = 60_000;

export async function ensureLocalFolderTree(folders: Folder[], vaultRoot: string): Promise<void> {
  const prev = materialized.get(folders);
  const now = Date.now();
  if (prev && prev.root === vaultRoot && now - prev.at < REMATERIALIZE_MS) return;
  let anyOk = false;
  for (const p of localFolderPaths(folders, vaultRoot)) {
    try {
      await mkdir(p, { recursive: true });
      anyOk = true;
    } catch {
      // exists / permission — fine; next sync retries.
    }
  }
  // Remember only a run that actually reached the disk: if every mkdir failed
  // (drive not ready, permissions) the next pass must try again at once.
  if (anyOk) materialized.set(folders, { root: vaultRoot, at: now });
}
