import type { Folder, FolderId } from "./types";

/**
 * Sanitize ONE path segment (a single folder or file name) before it's joined
 * into a local destination path.
 *
 * Folder/file names come straight from the DB (set by any vault member) and
 * are interpolated into local filesystem paths. Without validation, a name
 * like `..`, `/etc/passwd`, or `C:\Windows` could let a write escape the vault
 * root — a path-traversal vulnerability. We defang each segment so it can only
 * ever name a single child under its parent:
 *   - strip C0/C1 control characters
 *   - drop a leading Windows drive-letter prefix (e.g. `C:`)
 *   - replace path separators (`/`, `\`) inside the name with `_` so it can't
 *     spawn extra path components
 *   - neutralize `.` / `..` (which would stay-put / walk-up) to `_` / `__`
 *   - fall back to `_` for an empty result
 *
 * Ordinary names (spaces, dots in extensions, dashes, Unicode) pass through
 * byte-identical, so this doesn't change how legitimate files are matched or
 * stored — only how malicious/malformed ones are contained.
 */
export function sanitizePathSegment(name: string): string {
  let s = name;
  // 1. Strip C0 (U+0000-U+001F) and C1 (U+007F-U+009F) control characters.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  // 2. Drop a leading drive-letter prefix like "C:" / "c:".
  s = s.replace(/^[a-zA-Z]:/, "");
  // 3. Collapse any path separators inside the segment — a name must never
  //    introduce additional path components.
  s = s.replace(/[/\\]+/g, "_");
  // 4. Neutralize traversal/no-op segments so they can't walk the tree.
  if (s === ".") s = "_";
  else if (s === "..") s = "__";
  // 5. Never emit an empty segment (would collapse "a//b" -> "a/b" and shift
  //    later components up a level).
  if (s === "") s = "_";
  return s;
}

/**
 * Compute the slash-joined folder path for a given folder_id by walking up the
 * `parent_id` chain. Returns "" for root (folderId === null) and "" if the
 * folder isn't found. Each folder name is sanitized (see sanitizePathSegment)
 * so a malicious name can't inject extra components or `..` traversal.
 *
 * Example:
 *   folderPath("frame-id", folders) → "chassis/frame"
 */
export function folderPath(folderId: FolderId | null, folders: Folder[]): string {
  if (!folderId) return "";
  const f = folders.find((x) => x.id === folderId);
  if (!f) return "";
  const parent = folderPath(f.parent_id, folders);
  const name = sanitizePathSegment(f.name);
  return parent ? `${parent}/${name}` : name;
}

/**
 * Compute the slash-joined folder path using RAW, UNSANITIZED DB folder names
 * (the exact `name` values stored in pdm.folders). Returns "" for root
 * (folderId === null) and "" if the folder isn't found.
 *
 * ⚠️ NEVER use this for filesystem paths. The raw names can contain `/`, `\`,
 * `..`, drive-letter prefixes, or control characters — interpolating them into
 * a local path is a path-traversal hole. Use `folderPath` (which sanitizes each
 * segment) for anything that touches disk.
 *
 * This exists solely so drag-and-drop import can build a `targetPrefix` that
 * `ensureFolderHierarchy` (in useAddLocalFile) can match against existing
 * folders by their literal DB names — sanitizing here would make the prefix
 * fail to match a folder whose real name contains a now-rewritten character.
 *
 * Example:
 *   folderNamePath("frame-id", folders) → "Chassis/Front Frame"
 */
export function folderNamePath(folderId: FolderId | null, folders: Folder[]): string {
  if (!folderId) return "";
  const f = folders.find((x) => x.id === folderId);
  if (!f) return "";
  const parent = folderNamePath(f.parent_id, folders);
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
  const name = sanitizePathSegment(fileName);
  return sub ? `${vaultRoot}/${sub}/${name}` : `${vaultRoot}/${name}`;
}

/**
 * Compute the VAULT-RELATIVE path (no root prefix) for a file given its folder
 * id + name. This is exactly the suffix `localDestPath` appends to the root, and
 * it matches `vaultRelativePath(file, folders)` for the same file — both sanitize
 * each segment identically, so a path recorded here keys the sync ledger the same
 * way the auto-sync scan looks it up. Use this at materialization call sites that
 * have a (folderId, fileName) pair but not a full VaultFile in scope (RowActions,
 * useBulkDownload).
 */
export function vaultRelPathFor(
  folderId: FolderId | null,
  fileName: string,
  folders: Folder[],
): string {
  const sub = folderPath(folderId, folders);
  const name = sanitizePathSegment(fileName);
  return sub ? `${sub}/${name}` : name;
}
