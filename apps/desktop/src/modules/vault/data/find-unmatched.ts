import type { Folder, VaultFile } from "./types";
import type { LocalFile } from "./useLocalFolderScan";
import { vaultRelativePath } from "./local-match";

/**
 * Return local files that don't have a matching vault file (by relative path).
 * These are candidates for "Add to Vault".
 */
export function findUnmatchedLocal(
  vaultFiles: VaultFile[],
  localFiles: LocalFile[],
  folders: Folder[],
): LocalFile[] {
  const expected = new Set(vaultFiles.map((f) => vaultRelativePath(f, folders)));
  return localFiles.filter((l) => !expected.has(l.relativePath));
}
