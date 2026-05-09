import type { VaultFile, Version } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import type { LocalStatus } from "../components/LocalStatusBadge";
import type { FileId } from "./types";

export interface LocalMatch {
  status: LocalStatus;
  local?: LocalFile;
}

/**
 * Match a single vault file to a local file by basename. If multiple local
 * files share the basename, the first one wins (deterministic — sorted by
 * relativePath).
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
  versionsByFileId: Map<FileId, Version[]>,
): LocalMatch {
  if (localFiles === null) return { status: "no-folder" };

  const candidates = localFiles
    .filter((l) => l.basename === file.name)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (candidates.length === 0) return { status: "vault-only" };
  const local = candidates[0];

  const versions = versionsByFileId.get(file.id) ?? [];
  const latest = versions[0]; // versions are ordered version_num desc by useVersions
  if (!latest) {
    // Vault file exists but has no version yet — treat the local copy as a candidate
    // for an initial check-in. Use "modified" so it shows up in the change list.
    return { status: "modified", local };
  }
  return {
    status: latest.sha256 === local.sha256 ? "synced" : "modified",
    local,
  };
}
