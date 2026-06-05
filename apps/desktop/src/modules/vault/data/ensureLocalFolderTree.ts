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
export async function ensureLocalFolderTree(folders: Folder[], vaultRoot: string): Promise<void> {
  for (const p of localFolderPaths(folders, vaultRoot)) {
    try {
      await mkdir(p, { recursive: true });
    } catch {
      // exists / permission — fine; next sync retries.
    }
  }
}
