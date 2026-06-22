import type { Folder, FolderId, FileId } from "./types";

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
  const byId = new Map(folders.map((x) => [x.id, x]));
  // Iterative walk up the parent_id chain with a cycle/depth guard. A corrupt
  // chain (self-parent or a loop) must never stack-overflow — folderPath is on
  // the hot sync-match path, so a single bad row would otherwise make the whole
  // Vault UI unopenable. Mirrors the guard the sibling walkers in this file use.
  const segments: string[] = [];
  let cur = byId.get(folderId);
  if (!cur) return "";
  const visited = new Set<FolderId>();
  let guard = 0;
  while (cur && guard++ < 64) {
    if (visited.has(cur.id)) break; // cycle — stop walking
    visited.add(cur.id);
    segments.unshift(sanitizePathSegment(cur.name));
    if (!cur.parent_id) break;
    cur = byId.get(cur.parent_id);
  }
  return segments.join("/");
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
  const byId = new Map(folders.map((x) => [x.id, x]));
  // Iterative walk with the same cycle/depth guard as folderPath — a corrupt
  // parent_id chain must never stack-overflow (uses RAW names, see warning above).
  const segments: string[] = [];
  let cur = byId.get(folderId);
  if (!cur) return "";
  const visited = new Set<FolderId>();
  let guard = 0;
  while (cur && guard++ < 64) {
    if (visited.has(cur.id)) break; // cycle — stop walking
    visited.add(cur.id);
    segments.unshift(cur.name);
    if (!cur.parent_id) break;
    cur = byId.get(cur.parent_id);
  }
  return segments.join("/");
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

// ── Navigation-state helpers (M12 / M14 / M16) ───────────────────────────────

/**
 * Returns true iff `folderId` is a strict descendant of `ancestorId` in the
 * live `folders` list (i.e. NOT the folder itself). Walks the `parent_id`
 * chain upward from `folderId`; returns false if `folderId` is not present in
 * the list or if the walk never reaches `ancestorId`.
 *
 * Used by M16 to check whether the currently-open folder is inside a subtree
 * that has just been deleted.
 */
export function isDescendantOf(
  folders: Folder[],
  folderId: FolderId,
  ancestorId: FolderId,
): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = byId.get(folderId);
  if (!cur) return false;
  // Walk upward from the folder's own parent (so a folder is NOT a descendant
  // of itself).
  let parentId = cur.parent_id;
  let guard = 0;
  while (parentId && guard++ < 64) {
    if (parentId === ancestorId) return true;
    const parent = byId.get(parentId);
    if (!parent) break;
    parentId = parent.parent_id;
  }
  return false;
}

/**
 * Finds the nearest ancestor of `folderId` that is present in `liveIds`.
 * Walks up `parent_id` chains using `allFolders` (the full pre-deletion
 * folder list, so parent_id links are intact even for deleted folders) and
 * skips any ancestor whose id is not in `liveIds`.
 *
 * Parameters:
 *   allFolders — the complete folder list INCLUDING the folder being deleted
 *                (call this before the post-mutation refetch, or pass the
 *                stale list; only parent_id links matter, not live state).
 *   liveIds    — the Set of folder ids that are still live (i.e. not deleted).
 *   folderId   — the folder whose nearest live ancestor is requested.
 *
 * Returns:
 *   - the id of the nearest live ancestor, or
 *   - null if no live ancestor exists (folder is at the root level or all
 *     ancestors have been deleted / are unknown).
 *
 * Used by M16: when a folder is deleted and `selectedFolder` is the deleted
 * folder or a descendant of it, BrowseScreen resets to the nearest live
 * ancestor instead of jumping all the way to root.
 */
export function nearestLiveAncestor(
  allFolders: Folder[],
  liveIds: Set<FolderId>,
  folderId: FolderId,
): FolderId | null {
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const startFolder = byId.get(folderId);
  if (!startFolder) return null; // completely unknown id

  let parentId: FolderId | null = startFolder.parent_id;
  let guard = 0;
  while (parentId && guard++ < 64) {
    if (liveIds.has(parentId)) return parentId; // found a live ancestor
    // parentId is not live — keep walking up using allFolders for parent links
    const parentFolder = byId.get(parentId);
    if (!parentFolder) break; // parent unknown entirely
    parentId = parentFolder.parent_id;
  }
  return null;
}

/**
 * Compute the breadcrumb path for `selectedFolderId` using only resolvable
 * (live) folders. Walks up `parent_id` chains the same way the existing
 * breadcrumb `useMemo` does, but stops at the first missing link instead of
 * silently dropping that ancestor.
 *
 * Returns an array of Folder objects ordered from the highest resolvable
 * ancestor down to `selectedFolderId`. If `selectedFolderId` itself is not in
 * the live list, returns [].
 *
 * Used by M12 (Breadcrumbs.tsx) to replace the inline `useMemo`.
 */
export function resolveBreadcrumbPath(
  folders: Folder[],
  selectedFolderId: FolderId,
): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  let cur = byId.get(selectedFolderId);
  if (!cur) return [];
  // Walk upward collecting each resolvable folder.
  let guard = 0;
  while (cur && guard++ < 64) {
    out.unshift(cur);
    if (!cur.parent_id) break; // reached a root-level folder
    const parent = byId.get(cur.parent_id);
    if (!parent) break; // chain broken — stop here, don't emit ghost links
    cur = parent;
  }
  return out;
}

/**
 * Returns a new Set containing only the ids from `selected` that are NOT in
 * `succeededIds`. In other words: keeps only the failed ids so the user can
 * retry, clearing the rows that were successfully deleted.
 *
 * Used by M14 (context-menu multi-file delete in BrowseScreen) to mirror
 * how BulkActionBar.bulkDelete keeps the selection for retryable failures.
 */
export function selectionAfterPartialDelete(
  selected: Set<FileId>,
  succeededIds: FileId[],
): Set<FileId> {
  const done = new Set(succeededIds);
  const next = new Set<FileId>();
  for (const id of selected) {
    if (!done.has(id)) next.add(id);
  }
  return next;
}
