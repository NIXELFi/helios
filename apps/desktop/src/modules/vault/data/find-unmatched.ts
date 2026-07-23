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

/**
 * True iff the (files, folders) row snapshots are a coherent view of ONE vault:
 * every row belongs to `vaultId`, and every file's folder_id resolves in the
 * folder list. Absence-based verdicts (unmatched-local "add" candidates, and
 * anything that feeds auto-add) must be computed only from a consistent
 * snapshot:
 *  - on a vault switch, files/folders refetch at different times, so vault A
 *    rows transiently pair with vault B's — every local file looks like a new
 *    "add" candidate for the wrong vault;
 *  - a realtime file event can land before the folder refetch that carries its
 *    parent, and an unresolvable folder collapses the expected path to the
 *    vault root (folderPath returns ""), corrupting the comparison set.
 * Returning false just skips the verdicts for a pass; the follow-up refetch
 * produces a consistent snapshot and self-heals.
 */
export function vaultSnapshotConsistent(
  vaultId: string | null | undefined,
  vaultFiles: VaultFile[],
  folders: Folder[],
): boolean {
  if (!vaultId) return false;
  if (vaultFiles.some((f) => f.vault_id !== vaultId)) return false;
  if (folders.some((f) => f.vault_id !== vaultId)) return false;
  const folderIds = new Set(folders.map((f) => f.id));
  return vaultFiles.every((f) => f.folder_id === null || folderIds.has(f.folder_id));
}
