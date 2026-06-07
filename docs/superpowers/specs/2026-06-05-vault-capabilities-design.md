# Vault Capability Expansion v1 — Design Spec

**Date:** 2026-06-05
**Status:** Approved by Nick (MVP scope; rename/move deferred)

## Summary

Five vault improvements: (1) the local working copy always materializes the
full vault folder tree (both download modes, including empty folders);
(2) folder deletion with role rules, implemented as soft-delete into the
existing Deleted screen; (3) locally-deleted files propagate to the vault
when checked out, and are restored-with-warning when not; (4) drag-and-drop
file import plus an expanded right-click menu; (5) reveal-in-Explorer from
the file list.

**Governing principle (Nick):** nothing in the vault is ever hard-deleted.
"Delete" always means soft-delete into the Deleted screen; only local
copies physically disappear. The database keeps everything.

## Goals

- Folder scaffolding appears locally automatically so data entry into the
  tree is frictionless.
- Any editor can delete an *empty* folder; only admins/owners can delete a
  folder containing live files. Normal users can self-serve by checking out
  and deleting their own files first, emptying the folder.
- Deleting a checked-out file locally (incl. via File Explorer) moves it to
  the vault's Deleted screen. Deleting a non-checked-out file locally gets
  it restored with a clear "check out first to delete" message — in Helios
  and as an OS notification (covers Explorer-originated deletes).
- Files can be dragged from Explorer into the vault UI to add them.
- Common actions reachable via right-click; file locations reachable in one
  click.

## Non-goals (deferred)

- Rename / move of files or folders — blocked on SolidWorks reference
  preservation, explicitly out of scope this release.
- Folder-level permissions (roles remain vault-wide).
- Filesystem-watcher (real-time) deletion detection; the sync-pass ledger
  is the mechanism (Approach A).
- Deletion detection in manual download mode.
- Hard deletes of any kind, anywhere.

## 1. Database (one timestamped migration in infra/pdm-supabase)

Schema changes:

```sql
alter table pdm.folders add column deleted_at  timestamptz;
alter table pdm.folders add column deleted_by  uuid references auth.users(id);
alter table pdm.folders add column delete_batch uuid;
alter table pdm.files   add column delete_batch uuid;
```

New security-definer RPCs (with `public.pdm_*` wrappers, matching the
existing convention):

**`pdm.delete_folder(p_folder_id uuid, p_reason text default null)`**
1. Resolve the folder's subtree (recursive CTE over live folders).
2. Count live files (`deleted_at is null`) in the subtree.
   - 0 live files → caller needs `can_edit_in(vault_id)`.
   - >0 live files → caller needs `is_admin_in(vault_id)`; otherwise raise
     `42501` with a message the UI maps to the disabled-reason text.
3. Generate one `v_batch uuid`. Soft-delete every subtree folder and every
   live contained file: set `deleted_at = now()`, `deleted_by = auth.uid()`,
   `delete_batch = v_batch`. Release any active locks on affected files
   (mirroring `pdm.delete_file`).
4. Audit-log one folder-delete event (target folder, batch, file count).

**`pdm.restore_folder(p_folder_id uuid)`**
1. Auth: `deleted_by = auth.uid()` or `is_admin_in(vault_id)` (same rule as
   `pdm.restore_file`).
2. Read the folder's `delete_batch`; clear `deleted_at/deleted_by/
   delete_batch` on all folders and files sharing that batch. Files deleted
   individually *before* the folder delete keep their own deletion.
3. Restore re-creates the full ancestry: if a restored folder's parent is
   itself deleted (different batch), restore that parent chain too (folders
   only, not the parent's files) so nothing comes back orphaned.
4. Audit-logged.

`pdm.delete_file` / `pdm.restore_file` are untouched (single-file deletes
carry `delete_batch = null`).

**Live-data integration:** every existing folder query (browse tree, bridge
snapshot path resolution, add-file `ensureFolderHierarchy`, admin screens)
gains `deleted_at is null`. The folders RLS select policy stays permissive
(consistent with files: deleted rows are visible so the Deleted screen can
render them; filtering is a query concern).

## 2. Sync engine

### 2a. Folder materialization

New util `ensureLocalFolderTree(folders, vaultRoot)` in
`apps/desktop/src/modules/vault/data/` — computes every live folder's local
path via the existing `folder-paths.ts` helpers and `mkdir`s it recursively
(Tauri fs). Idempotent, ignores already-existing dirs, never touches files.

Call sites:
- **Auto mode:** start of each `useAutoSync` pass (before download
  partitioning), so new folders appear within one sync cycle.
- **Manual mode:** on vault structure load/refresh in the Browse screen
  (folders list arrival), so manual users get scaffolding without any
  download action. Both modes require a configured local folder; no-op
  otherwise.

### 2b. Local-deletion ledger (Approach A)

New module `sync-ledger.ts`: a per-vault JSON file
`%LOCALAPPDATA%\Helios\sync-ledger-<vaultId>.json` mapping
`relpath → { sha256, recordedAt }`. Stored OUTSIDE the vault root so users
can't delete or sync it accidentally.

- **Record** on successful auto-sync download, manual download, check-in,
  and add-to-vault.
- **Remove** on vault-side soft-delete (reaper pass) and on propagated
  local deletes.
- Corrupt/missing ledger ⇒ treated as empty. Failure mode is safe by
  construction: delete-propagation requires a positive ledger hit AND an
  active lock held by the current user, so an empty ledger can only cause
  redundant re-downloads, never a false vault delete.

### 2c. Deletion detection (auto mode only)

`useAutoSync`'s partition gains a third bucket: file is live in the vault,
present in the ledger, but missing from the local scan ⇒ locally deleted.

- **Locked by me** → call `pdm_delete_file` (soft-delete to the Deleted
  screen), remove from ledger, surface a success toast ("moved to
  Deleted"). Audit comes free from the RPC.
- **Not locked by me** → re-download (existing behavior), refresh the
  ledger entry, and emit a `localDeleteBlocked` event with the file name.
  The refreshed ledger entry means one warning per deletion, not one per
  sync pass.

### 2d. Reaper extension

After `useDeletedFileReaper` removes local copies of vault-deleted files,
a folder pass removes local directories of vault-deleted folders — only if
empty after the file reap. Directories containing untracked local files are
left alone (never delete data the vault doesn't own).

## 3. Warnings

- **In-app:** a dismissible banner in the Vault module (fed by
  `localDeleteBlocked` events): "`part.sldprt` was deleted locally but
  isn't checked out — restored from vault. Check out first to delete."
  Multiple files coalesce into one banner with a list.
- **OS notification** via the Tauri notification plugin (registered in
  capabilities; permission requested once on first use): same message,
  fired alongside the banner. This is the File-Explorer-side surface — the
  delete usually *happened* in Explorer, and the toast arrives regardless
  of which app deleted the file. The plugin is additive (new capability +
  Cargo/npm dep) and used only for this event in v1.

## 4. UI capabilities

### 4a. Drag-and-drop import

- Use Tauri's webview drag-drop events (`getCurrentWebview()
  .onDragDropEvent`) — native drops carry absolute paths; HTML5 drops do
  not. Active only while the Vault module is the visible module and the
  Browse screen is mounted.
- Hover targeting: on drag-over, hit-test the cursor position
  (`document.elementFromPoint`) against elements carrying
  `data-folder-id`; highlight the hovered tree node / table region. Drop
  resolves to that folder, else the currently selected folder.
- Drop handling: for each dropped file, run the existing `useAddLocalFile`
  flow into the target folder (same draft + checkout semantics as Add
  today; idempotent on duplicate SHA). NOTE: `useAddLocalFile.run()` has no
  target-folder parameter today — it derives the hierarchy from
  `local.relativePath` rooted at the vault root. The implementation must
  either prepend the target folder's vault path to the synthesized
  relativePath or add an explicit target-folder parameter to the hook
  (planner's choice; the prepend keeps the hook's signature stable). Dropped *directories* are walked
  recursively and their relative structure is created via the existing
  `ensureFolderHierarchy`. Unsupported/failed items are reported in a
  per-item result list; a progress indicator shows during multi-file
  drops. Requires `canEdit`; drops while viewer-only show a single
  disabled-reason notice.

### 4b. Context menu expansion

Extend the existing `TreeContextMenu` action builders (Browse screen):

| Target | New actions |
|---|---|
| Folder | New folder…, Delete folder, Copy vault path, Reveal in Explorer |
| File | Delete, Copy local path, Copy name, Reveal in Explorer |

- *Delete folder* is state-gated: enabled for editors when the subtree has
  no live files; enabled for admins always; otherwise disabled with reason
  "Contains files — admins only (or empty it first)". The emptiness check
  uses already-loaded browse data; the RPC re-checks server-side (the race
  is resolved by the server's answer).
- *New folder…* reuses the existing create-folder dialog, parented at the
  right-clicked folder.
- *Copy* actions write to the clipboard via the existing Tauri clipboard
  capability (or `navigator.clipboard` if already in use).
- Existing actions (check-out/in, get-latest, cancel, history, add) are
  untouched.
- The Deleted screen (component: `screens/RecycleScreen.tsx`, data:
  `useDeletedFiles.ts`) gains folder rows with Restore (calls
  `pdm_restore_folder`), shown alongside deleted files.

### 4c. Reveal in Explorer

- Clicking a synced file's name (and the context action) launches
  `explorer /select,"<localPath>"` via the Tauri shell capability —
  Explorer opens the parent folder with the file highlighted.
- Vault-only files (no local copy): the name-click falls back to nothing
  (cursor stays default) and the context action is disabled with reason
  "Not downloaded". Folders' Reveal opens the folder directly (it always
  exists locally once materialization lands).
- Windows-only in v1 (the team runs Windows for SolidWorks; macOS
  `open -R` is a one-line follow-up if ever needed).

## 5. Integration map (what touches what)

| Existing piece | Change |
|---|---|
| `useAutoSync` | + materialization call, + third partition bucket, + ledger record on download |
| `useDownloadVersion` / manual download | + ledger record |
| `useCheckIn`, `useAddLocalFile` | + ledger record |
| `useDeletedFileReaper` | + ledger removal, + empty-dir reap for deleted folders |
| `useBridgeSync` snapshot | folders filtered to live; deleted files already excluded |
| Browse screen queries | folders gain `deleted_at is null` |
| Deleted screen | + folder rows + restore action |
| `TreeContextMenu` builders | + new actions (state-gated) |
| `FolderTree` / `FileTable` | + `data-folder-id` attributes, + name-click reveal, + drop highlight |
| Tauri capabilities | + notification plugin, + shell `explorer` allowlist entry, webview drag-drop |
| Shell extension (C#) | unchanged in v1 — Explorer-side messaging is the OS toast, not new verbs |

## 6. Error handling

- Ledger corrupt/missing → empty ledger (safe: see 2b).
- `pdm_delete_folder` race (file added after UI check) → server re-check
  raises; UI surfaces the message and refreshes.
- Drag-drop failures → per-item results; one failure doesn't abort the
  batch (AbortController cancels cleanly on unmount, matching
  BulkActionBar's pattern).
- Reveal with no local file → disabled action; never a dead `explorer`
  spawn.
- Notification permission denied → in-app banner still shows; OS toast
  silently skipped.

## 7. Testing

- Vitest: `sync-ledger` (record/remove/classify; corrupt-file fallback),
  auto-sync third-bucket partition (mocked scan/locks/ledger),
  `ensureLocalFolderTree` (mocked fs, idempotency), `useDeleteFolder` /
  `useRestoreFolder` hooks (RPC shapes, role-error mapping), drop-target
  hit-test helper (pure function), context-menu action builders
  (state-gating incl. disabled reasons).
- Migration carries commented fixture spot-checks: editor deletes empty
  folder → ok; editor deletes non-empty → 42501; admin deletes non-empty →
  batch-stamped subtree; restore folder → exactly the batch returns;
  individually-deleted file stays deleted.
- Manual smoke: Explorer-delete a checked-out file → appears in Deleted
  screen; Explorer-delete a non-checked-out file → restored + OS toast +
  banner; create folder on machine A → appears as empty local dir on
  machine B (both modes); drag 3 files onto a tree folder → added as
  drafts, checked out.
