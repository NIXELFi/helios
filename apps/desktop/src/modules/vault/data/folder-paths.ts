import type { Folder, FolderId } from "./types";

/**
 * Compute the slash-joined folder path for a given folder_id by walking up the
 * `parent_id` chain. Returns "" for root (folderId === null) and "" if the
 * folder isn't found.
 *
 * Example:
 *   folderPath("frame-id", folders) → "chassis/frame"
 */
export function folderPath(folderId: FolderId | null, folders: Folder[]): string {
  if (!folderId) return "";
  const f = folders.find((x) => x.id === folderId);
  if (!f) return "";
  const parent = folderPath(f.parent_id, folders);
  return parent ? `${parent}/${f.name}` : f.name;
}

/** Compute the local destination path for a vault file. */
export function localDestPath(
  vaultRoot: string,
  folderId: FolderId | null,
  fileName: string,
  folders: Folder[],
): string {
  const sub = folderPath(folderId, folders);
  return sub ? `${vaultRoot}/${sub}/${fileName}` : `${vaultRoot}/${fileName}`;
}
