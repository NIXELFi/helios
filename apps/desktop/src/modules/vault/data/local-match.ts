import type { Folder, VaultFile, Version } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import type { LocalStatus } from "../components/LocalStatusBadge";
import { folderPath } from "./folder-paths";

export interface LocalMatch {
  status: LocalStatus;
  local?: LocalFile;
}

/** Compute the expected relative path of a vault file within the local folder. */
export function vaultRelativePath(file: VaultFile, folders: Folder[]): string {
  const sub = folderPath(file.folder_id, folders);
  return sub ? `${sub}/${file.name}` : file.name;
}

/**
 * Normalize a relative path for *comparison only* (never for display/storage).
 *
 * macOS's filesystem is case-insensitive and `readDir` returns NFD-normalized
 * Unicode, while the DB stores names verbatim (typically NFC). An exact string
 * compare therefore mismatches present files — they show as vault-only/modified
 * (re-downloaded every sync) and already-vaulted files reappear as "add"
 * candidates. Folding to NFC + lowercase on both sides makes the compare robust.
 */
export function normalizePathForCompare(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

/**
 * Match a single vault file to a local file by full relative path
 * (vault folder hierarchy + filename). This eliminates false matches where
 * two files in different folders share the same basename.
 *
 * Status:
 *  - "no-folder"  → the user hasn't picked a folder; we don't have data
 *  - "vault-only" → vault file exists, no local match
 *  - "synced"     → local file matches the latest version's sha256
 *  - "modified"   → local file exists but sha differs from latest version
 */
export function matchLocal(
  file: VaultFile,
  localFiles: LocalFile[] | null,
  versionsByFileId: Map<string, Version[]>,
  folders: Folder[] = [],
): LocalMatch {
  if (localFiles === null) return { status: "no-folder" };

  const expected = normalizePathForCompare(vaultRelativePath(file, folders));
  const local = localFiles.find((l) => normalizePathForCompare(l.relativePath) === expected);
  if (!local) return { status: "vault-only" };

  const versions = versionsByFileId.get(file.id) ?? [];
  const latest = versions[0];
  if (!latest) return { status: "modified", local }; // file row exists, no version yet
  return {
    status: latest.sha256 === local.sha256 ? "synced" : "modified",
    local,
  };
}
