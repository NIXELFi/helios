import type { Folder, VaultFile, Version } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import type { LocalStatus } from "../components/LocalStatusBadge";
import { folderPath, sanitizePathSegment } from "./folder-paths";

export interface LocalMatch {
  status: LocalStatus;
  local?: LocalFile;
}

/** Compute the expected relative path of a vault file within the local folder. */
export function vaultRelativePath(file: VaultFile, folders: Folder[]): string {
  const sub = folderPath(file.folder_id, folders);
  // Sanitize the file name exactly like localDestPath does when it writes the
  // working copy to disk, so a name that needs sanitizing (e.g. an embedded
  // path separator) still matches its on-disk copy instead of looking
  // "vault-only" and re-downloading on every sync. Ordinary names are
  // unchanged, so this is a no-op for the common case.
  const name = sanitizePathSegment(file.name);
  return sub ? `${sub}/${name}` : name;
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
    // Case-insensitive: local shas are lowercase hex; a version row's sha256
    // could be uppercase/mixed (legacy import) — a verbatim compare would
    // mark a synced file "modified" and trigger an endless re-download.
    status: latest.sha256?.toLowerCase() === local.sha256?.toLowerCase() ? "synced" : "modified",
    local,
  };
}
