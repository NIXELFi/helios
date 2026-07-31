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
 * It ALSO defangs the names Windows simply refuses to create — the sibling
 * `sanitizeVaultName` (useVaultFolder.ts) already did this and the mismatch was
 * a real sync bug: a folder named `Rev1.` or `R&D: v2` produced a path that
 * `mkdir`/`writeFile` either rejected or silently rewrote (Windows strips
 * trailing dots/spaces), so what `readDir` reported back never equalled the key
 * we computed and those files stayed permanently "vault-only", re-downloaded
 * every pass. So additionally:
 *   - replace the Windows-illegal characters `: * ? " < > |` with `_`
 *   - strip trailing dots/spaces (Windows drops them when creating the entry)
 *   - suffix `_` onto reserved DOS device names (CON, PRN, AUX, NUL, COM1-9,
 *     LPT1-9), which can't be used as a file/dir name at all
 *
 * Ordinary names (spaces, dots in extensions, dashes, Unicode) pass through
 * byte-identical, so this doesn't change how legitimate files are matched or
 * stored — only how malicious/malformed ones are contained.
 */
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

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
  // 4. Replace the remaining Windows-illegal characters. Same class as
  //    sanitizeVaultName; without this the computed key can never match what
  //    the filesystem actually stores (see the doc comment above).
  s = s.replace(/[:*?"<>|]/g, "_");
  // 5. Neutralize traversal/no-op segments so they can't walk the tree. Done
  //    BEFORE the trailing-dot strip so `.`/`..` don't collapse to "".
  if (s === ".") s = "_";
  else if (s === "..") s = "__";
  // 6. Strip trailing dots and spaces — Windows silently drops them when it
  //    creates the entry, so keeping them guarantees a key/readDir mismatch.
  s = s.replace(/[. ]+$/, "");
  // 7. Reserved DOS device names are unusable even with an extension
  //    (`CON.txt` is still the console). Suffix the BASE so the extension —
  //    which SolidWorks and the type filters key off — survives intact.
  const dot = s.indexOf(".");
  const base = dot === -1 ? s : s.slice(0, dot);
  if (RESERVED_DEVICE_NAMES.has(base.toUpperCase())) {
    s = dot === -1 ? `${base}_` : `${base}_${s.slice(dot)}`;
  }
  // 8. Never emit an empty segment (would collapse "a//b" -> "a/b" and shift
  //    later components up a level).
  if (s === "") s = "_";
  return s;
}

/**
 * Walk `folderId`'s `parent_id` chain to a root, returning the ordered folder
 * rows (highest ancestor first) — or NULL when the chain can't be walked to a
 * genuine root:
 *   - `folderId` itself isn't in `folders`
 *   - a MID-CHAIN ancestor is missing (the classic stale/partial folder fetch)
 *   - the chain cycles, or exceeds the depth guard
 *
 * The null return is the whole point. The previous inline walk exited the loop
 * on a missing ancestor and returned whatever it had collected, i.e. a PARTIAL
 * path — `chassis/frame/subframe` silently became `frame/subframe`. That key
 * matches nothing on disk, and every consumer that compares computed keys to a
 * local scan (auto-sync, the reaper's `liveRels`) then classified real files as
 * unknown. In the reaper that meant a user's legitimate read-only working copies
 * matched neither the live nor the deleted set and were DELETED as orphans.
 *
 * Callers that touch disk for a specific file must treat null as "skip this
 * file for the pass" — the folder refetch self-heals the next pass. This is the
 * module's "never act on unverifiable absence" rule.
 *
 * The depth/cycle guard matches the sibling walkers in this file: a corrupt row
 * must never stack-overflow, since these run on the hot sync-match path and one
 * bad row would otherwise make the whole Vault UI unopenable.
 */
function folderChain(folderId: FolderId, folders: Folder[]): Folder[] | null {
  const byId = new Map(folders.map((x) => [x.id, x]));
  const chain: Folder[] = [];
  let cur = byId.get(folderId);
  if (!cur) return null;
  const visited = new Set<FolderId>();
  let guard = 0;
  while (guard++ < 64) {
    if (visited.has(cur.id)) return null; // cycle — no well-defined path
    visited.add(cur.id);
    chain.unshift(cur);
    if (!cur.parent_id) return chain; // reached a root-level folder: complete
    const parent = byId.get(cur.parent_id);
    if (!parent) return null; // broken link — the path is NOT knowable
    cur = parent;
  }
  return null; // depth guard tripped — treat as unresolvable, not as partial
}

/**
 * Compute the slash-joined folder path for a given folder_id by walking up the
 * `parent_id` chain. Returns "" for root (folderId === null) and "" if the
 * chain can't be fully resolved (unknown id, missing ancestor, cycle). Each
 * folder name is sanitized (see sanitizePathSegment) so a malicious name can't
 * inject extra components or `..` traversal.
 *
 * ⚠️ Best-effort by design: "" is indistinguishable from "the vault root", so
 * this is safe ONLY for display (breadcrumb-ish labels, search hit subtitles,
 * grouping keys) and for callers that have already checked `folderResolvable`.
 * Anything that touches disk for a SPECIFIC file must use `localDestPathStrict`
 * / `folderResolvable` and skip the file instead. It no longer returns a
 * partial path — a broken chain now collapses to "" (root), which the strict
 * helpers reject, rather than to a plausible-looking wrong path that they
 * would happily hand to `remove()`.
 *
 * Example:
 *   folderPath("frame-id", folders) → "chassis/frame"
 */
export function folderPath(folderId: FolderId | null, folders: Folder[]): string {
  if (!folderId) return "";
  const chain = folderChain(folderId, folders);
  if (!chain) return "";
  return chain.map((f) => sanitizePathSegment(f.name)).join("/");
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
  // Shares folderChain's all-or-nothing walk: a partial prefix here would make
  // ensureFolderHierarchy re-create the tail of the tree under the WRONG parent
  // (e.g. a root-level "Front Frame" beside the real "Chassis/Front Frame"),
  // which is exactly the duplicate-folder split that fights over one on-disk
  // path. "" (= the vault root) is the honest answer for an unknowable chain.
  const chain = folderChain(folderId, folders);
  if (!chain) return "";
  return chain.map((f) => f.name).join("/");
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
 * True iff `folderId`'s ENTIRE ancestor chain can be resolved against `folders`
 * (null = the vault root, always resolvable). When this is false, folderPath()
 * falls back to "" and every path helper silently collapses the file to the
 * VAULT ROOT — which made a stale/incomplete folder list read, write, chmod, or
 * delete a root-level file that merely shares the basename. Callers that touch
 * disk for a SPECIFIC file must check this (or use localDestPathStrict) and
 * skip the file for the pass instead; the folder refetch self-heals the pass
 * after.
 *
 * This validates the WHOLE chain, not just the leaf. Leaf-only was the P0: a
 * missing MID-chain ancestor left the leaf id present, so this returned true
 * while folderPath returned a truncated path — the strict helpers waved a
 * plausible-but-wrong path through to callers that then acted on disk with it.
 */
export function folderResolvable(folderId: FolderId | null, folders: Folder[]): boolean {
  return folderId === null || folderChain(folderId, folders) !== null;
}

/**
 * The set of folder ids whose FULL ancestor chain resolves in `folders` — the
 * bulk form of `folderResolvable` for hot loops (auto-sync partitions every
 * live file twice per pass; calling folderResolvable per file would rebuild the
 * id map each time). Computed in one pass with memoized chain results.
 */
export function resolvableFolderIds(folders: Folder[]): Set<FolderId> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const ok = new Set<FolderId>();
  const bad = new Set<FolderId>();
  for (const start of folders) {
    // Walk up remembering the path we took, then stamp every id on it with the
    // verdict the root-most step produced — so a deep tree costs O(n), not
    // O(n·depth), and a broken/cyclic branch is only walked once.
    const seen: FolderId[] = [];
    const visited = new Set<FolderId>();
    let cur: Folder | undefined = start;
    let verdict: boolean | null = null;
    let guard = 0;
    while (cur && guard++ < 64) {
      if (ok.has(cur.id)) { verdict = true; break; }
      if (bad.has(cur.id) || visited.has(cur.id)) { verdict = false; break; }
      visited.add(cur.id);
      seen.push(cur.id);
      if (!cur.parent_id) { verdict = true; break; } // reached a real root
      const parent: Folder | undefined = byId.get(cur.parent_id);
      if (!parent) { verdict = false; break; } // broken link
      cur = parent;
    }
    for (const id of seen) (verdict === true ? ok : bad).add(id);
  }
  return ok;
}

/** localDestPath, but returns null instead of collapsing to the vault root
 *  when the folder id can't be resolved (see folderResolvable). */
export function localDestPathStrict(
  vaultRoot: string,
  folderId: FolderId | null,
  fileName: string,
  folders: Folder[],
): string | null {
  if (!folderResolvable(folderId, folders)) return null;
  return localDestPath(vaultRoot, folderId, fileName, folders);
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
