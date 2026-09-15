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

/**
 * Decide whether auto-sync should HOLD BACK a locally-present file that
 * differs from the latest vault version (true = hold back / don't touch,
 * false = safe to refresh by downloading the new version over it).
 *
 * The read-only bit is the primary "clean copy" signal (reconciliation only
 * ever sets a SYNCED file read-only): a read-only local copy is always safe
 * to refresh regardless of the ledger.
 *
 * A WRITABLE copy is normally held back - it might be an unsaved local edit -
 * UNLESS its content is byte-identical to what THIS machine previously
 * materialized for this exact path, per the per-vault sync ledger
 * (`ledgerEntrySha`, i.e. `SyncLedger.entries[normalizedRelPath].sha256`). In
 * that case the writable bit is stale (predates the read-only model, or got
 * cleared some other way) but the content itself is just an older revision
 * this machine already had, not an edit, so it's safe to refresh. No
 * ledger entry for the path means we've never recorded materializing it here,
 * so there's nothing to compare against and the writable copy is held back.
 */
export function shouldHoldBack(local: LocalFile, ledgerEntrySha: string | undefined): boolean {
  if (local.readonly === true) return false;
  if (!ledgerEntrySha) return true;
  // Case-insensitive for the same reason as the synced/modified compare above:
  // ledger shas are written lowercase, but be defensive either way.
  return local.sha256?.toLowerCase() !== ledgerEntrySha.toLowerCase();
}
