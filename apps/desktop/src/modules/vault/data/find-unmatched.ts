import type { Folder, VaultFile } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { vaultRelativePath, normalizePathForCompare } from "./local-match";

/**
 * Return local files that don't have a matching vault file (by relative path).
 * These are candidates for "Add to Vault".
 *
 * Comparison keys are normalized (NFC + case-fold) so a present file isn't
 * re-offered as an "add" candidate just because macOS reported it NFD-encoded
 * or with different case than the DB stored — see normalizePathForCompare.
 */
export function findUnmatchedLocal(
  vaultFiles: VaultFile[],
  localFiles: LocalFile[],
  folders: Folder[],
): LocalFile[] {
  const expected = new Set(
    vaultFiles.map((f) => normalizePathForCompare(vaultRelativePath(f, folders))),
  );
  return localFiles.filter((l) => !expected.has(normalizePathForCompare(l.relativePath)));
}
