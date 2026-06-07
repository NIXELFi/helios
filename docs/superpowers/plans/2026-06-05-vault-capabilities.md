# Vault Capability Expansion v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local folder-tree materialization, folder soft-delete with role rules, local-deletion propagation/blocking via a sync ledger, drag-and-drop import, expanded context menus, and reveal-in-Explorer — per the approved spec.

**Architecture:** A per-vault JSON ledger (outside the vault root) lets the auto-sync pass distinguish "deleted locally" from "never downloaded". Folder deletion mirrors the existing file soft-delete RPC pattern with a `delete_batch` uuid for exact-restore. All UI lands in the existing BrowseScreen/FolderTree/FileTable/RecycleScreen surfaces.

**Tech Stack:** React 18 + TS + Vitest, Supabase `pdm` schema (security-definer RPCs), Tauri 2 (fs, notification plugins; one new Rust command for Explorer reveal).

**Spec:** `docs/superpowers/specs/2026-06-05-vault-capabilities-design.md` — read it first; it is the contract.

**Repo facts the executor must know:**

- Tests: `pnpm --filter @helios/desktop exec vitest run <path>`; typecheck: `pnpm --filter @helios/desktop exec tsc --noEmit` (run from repo root). tsconfig has `noUncheckedIndexedAccess: true` — indexed access types as `T | undefined`; use minimal commented `!` where provably safe.
- ⚠️ Pre-commit hook runs a ~2-minute Rust parity suite per commit. Normal. 5+ minute timeouts on commits; never `--no-verify`.
- Vault client: `useSupabaseClient()` from `@helios/auth`; default schema is `pdm`, so `client.from("folders")` and `client.rpc("pdm_delete_file")` hit pdm directly.
- Existing vault tests live in `apps/desktop/tests/vault/` (hook tests with mocked clients) and `apps/desktop/src/modules/vault/data/__tests__/` (pure logic). Match whichever style the nearest neighbor uses.
- Key existing code (READ before modifying): `data/useAutoSync.ts` (345 lines — generation/abort race machinery; respect it), `data/useDeletedFileReaper.ts`, `data/useAddLocalFile.ts` (ensureFolderHierarchy at line ~93), `data/folder-paths.ts`, `data/local-match.ts` (`vaultRelativePath`, `normalizePathForCompare`), `data/types.ts`, `screens/BrowseScreen.tsx` (877 lines — the wiring hub; context menu builder at ~line 642), `components/TreeContextMenu.tsx` (`MenuAction { label, onClick, danger?, disabledReason? }`), `components/FolderTree.tsx` (`TreeContextTarget` = `{kind:"folder", folder, descendantFiles}` | `{kind:"files", files}`), `screens/RecycleScreen.tsx`, `data/useDeletedFiles.ts`, `data/useCreateFolder.ts`, `data/useDeleteFile.ts` + `data/useRestoreFile.ts` (the hook pattern for the new folder hooks), migration `infra/pdm-supabase/supabase/migrations/20260603100000_pdm_drafts_and_soft_delete.sql` (the RPC pattern folder soft-delete mirrors).
- Tauri: `notification:default` permission ALREADY granted in `src-tauri/capabilities/default.json`; `tauri-plugin-notification = "2"` ALREADY in Cargo.toml — only the npm package `@tauri-apps/plugin-notification` is missing. `fs:allow-mkdir` + `**` scope already granted. Custom Rust commands live in `src-tauri/src/commands/` and are registered in `src-tauri/src/lib.rs` `generate_handler![...]` (see `commands::set_readonly::set_path_readonly` as the template).
- Migrations are authored in-repo and applied to the live project separately (Management API) — the plan only authors the SQL. Flag the apply step in the final report.

---

### Task 1: Folder soft-delete migration

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260606000000_pdm_folder_soft_delete.sql`

- [ ] **Step 1: Write the migration.** Mirror the style/comments of `20260603100000_pdm_drafts_and_soft_delete.sql` exactly (header comment explaining the change, sections, wrapper RPCs, grants):

```sql
-- Folder soft-delete (recycle bin) for pdm.folders + delete-batch restore.
--
-- Governing rule: NOTHING in the vault is ever hard-deleted. Deleting a
-- folder soft-deletes its whole subtree (folders + live files), stamping one
-- delete_batch uuid on everything so restore brings back exactly what that
-- deletion took — files deleted individually beforehand stay deleted.
--
-- Role rules: a subtree with zero live files can be deleted by any editor;
-- a subtree containing live files requires a vault admin/owner. Normal users
-- self-serve by checking out + deleting their files first (emptying it).

-- 1. Columns ----------------------------------------------------------------
alter table pdm.folders
  add column if not exists deleted_at   timestamptz,
  add column if not exists deleted_by   uuid,
  add column if not exists delete_batch uuid;
alter table pdm.files
  add column if not exists delete_batch uuid;

-- 2. delete_folder ------------------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.delete_folder(p_folder_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_vault uuid;
  v_live_files int;
  v_batch uuid := gen_random_uuid();
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id into v_vault from pdm.folders
    where id = p_folder_id and deleted_at is null;
  if v_vault is null then raise exception 'folder not found'; end if;

  -- Subtree = the folder + every live descendant folder.
  create temp table _subtree on commit drop as
    with recursive sub as (
      select id from pdm.folders where id = p_folder_id and deleted_at is null
      union all
      select f.id from pdm.folders f join sub on f.parent_id = sub.id
        where f.deleted_at is null
    )
    select id from sub;

  select count(*) into v_live_files from pdm.files
    where folder_id in (select id from _subtree) and deleted_at is null;

  if v_live_files = 0 then
    if not pdm.can_edit_in(v_vault) then
      raise exception 'editor or admin role required to delete folders';
    end if;
  else
    if not pdm.is_admin_in(v_vault) then
      raise exception 'folder contains % file(s) — only a vault admin can delete it (or empty it first)', v_live_files;
    end if;
  end if;

  -- Soft-delete files first (releasing any active locks), then folders.
  update pdm.locks set released_at = now()
    where released_at is null
      and file_id in (select id from pdm.files
                       where folder_id in (select id from _subtree)
                         and deleted_at is null);
  update pdm.files
     set deleted_at = now(), deleted_by = v_caller, delete_batch = v_batch
   where folder_id in (select id from _subtree) and deleted_at is null;
  update pdm.folders
     set deleted_at = now(), deleted_by = v_caller, delete_batch = v_batch
   where id in (select id from _subtree);

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'delete', 'folder', p_folder_id,
        jsonb_build_object('soft', true, 'batch', v_batch, 'files', v_live_files));
  exception when others then null; end;
end; $function$;

-- 3. restore_folder -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pdm.restore_folder(p_folder_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_vault uuid; v_deleter uuid; v_batch uuid;
  v_parent uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, deleted_by, delete_batch, parent_id
    into v_vault, v_deleter, v_batch, v_parent
    from pdm.folders where id = p_folder_id;
  if v_vault is null then raise exception 'folder not found'; end if;
  if not (v_deleter is not distinct from v_caller or pdm.is_admin_in(v_vault)) then
    raise exception 'only the person who deleted it (or an admin) can restore it';
  end if;

  if v_batch is not null then
    update pdm.folders set deleted_at = null, deleted_by = null, delete_batch = null
      where delete_batch = v_batch;
    update pdm.files set deleted_at = null, deleted_by = null, delete_batch = null
      where delete_batch = v_batch;
  else
    update pdm.folders set deleted_at = null, deleted_by = null
      where id = p_folder_id;
  end if;

  -- Re-anchor: if any ancestor of the restored folder is itself deleted
  -- (a different batch), restore the ancestor FOLDER chain (not its files)
  -- so nothing comes back orphaned.
  while v_parent is not null loop
    update pdm.folders set deleted_at = null, deleted_by = null, delete_batch = null
      where id = v_parent and deleted_at is not null;
    select parent_id into v_parent from pdm.folders where id = v_parent;
  end loop;

  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore', 'folder', p_folder_id, jsonb_build_object('batch', v_batch));
  exception when others then null; end;
end; $function$;

-- 4. PostgREST wrappers + grants (matching pdm_delete_file's posture).
CREATE OR REPLACE FUNCTION pdm.pdm_delete_folder(p_folder_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.delete_folder(p_folder_id); $function$;
CREATE OR REPLACE FUNCTION pdm.pdm_restore_folder(p_folder_id uuid)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'pdm', 'public'
AS $function$ select pdm.restore_folder(p_folder_id); $function$;

revoke all on function pdm.delete_folder(uuid)      from public;
revoke all on function pdm.restore_folder(uuid)     from public;
revoke all on function pdm.pdm_delete_folder(uuid)  from public;
revoke all on function pdm.pdm_restore_folder(uuid) from public;
grant execute on function pdm.delete_folder(uuid)      to authenticated;
grant execute on function pdm.restore_folder(uuid)     to authenticated;
grant execute on function pdm.pdm_delete_folder(uuid)  to authenticated;
grant execute on function pdm.pdm_restore_folder(uuid) to authenticated;

-- FIXTURE SPOT-CHECKS (manual, post-apply):
--   editor deletes empty folder        → ok, folder gains deleted_at+batch
--   editor deletes folder w/ live file → exception 'contains N file(s)'
--   admin deletes folder w/ live file  → subtree + files share one batch
--   restore_folder                     → exactly that batch returns
--   file deleted BEFORE folder delete  → stays deleted after restore
```

- [ ] **Step 2:** Visually verify against `20260603100000_...sql` conventions (wrappers, grants, audit try/catch). Note: `create temp table ... on commit drop` works inside PostgREST RPC transactions; if review prefers, a CTE-per-statement variant is acceptable — keep semantics identical.
- [ ] **Step 3: Commit** — `feat(vault): folder soft-delete migration (delete_batch subtree delete/restore RPCs)`

---

### Task 2: Live-folder filtering everywhere

**Files:**
- Modify: `apps/desktop/src/modules/vault/data/useFolders.ts` (~line 31: the select)
- Modify: `apps/desktop/src/modules/vault/data/types.ts` (Folder interface)
- Create: `apps/desktop/src/modules/vault/data/useDeletedFolders.ts`
- Test: `apps/desktop/tests/vault/useDeletedFolders.test.tsx`

- [ ] **Step 1:** Add to `Folder` in types.ts (mirroring VaultFile's comment style):

```ts
  /** Soft-delete metadata (pdm.folders.deleted_at / deleted_by / delete_batch).
   *  Non-null deleted_at = in the recycle bin: excluded from the browse tree,
   *  listed by useDeletedFolders, recoverable via pdm_restore_folder. */
  deleted_at?: string | null;
  deleted_by?: UserId | null;
  delete_batch?: string | null;
```

ALSO add `delete_batch?: string | null;` to the **`VaultFile`** interface (its
deleted_at/deleted_by already exist) — Task 10 reads it off deleted file rows
and tsc is strict; `FILE_WITH_LATEST_SELECT` starts with `*` so the column is
fetched without select changes.

- [ ] **Step 2:** In `useFolders.ts`, add `.is("deleted_at", null)` to the query chain (after `.eq("vault_id", vault_id)`). This single hook feeds the tree, `folder-paths`, the bridge snapshot, and auto-sync — one filter covers them all. `ensureFolderHierarchy` in `useAddLocalFile.ts` also needs `.is("deleted_at", null)` added to BOTH its lookup queries (initial + race re-query) so adding a file never reuses a deleted folder.
- [ ] **Step 3:** Write `useDeletedFolders.ts` — copy `useDeletedFiles.ts` verbatim, swapping table to `folders`, select to `"*"`, type to `Folder[]`, same pagination/order (`deleted_at` desc, `id` tiebreak).
- [ ] **Step 4: Test** `useDeletedFolders.test.tsx` — copy the structure of `apps/desktop/tests/vault/useVaults.test.tsx` (nearest mocked-client hook test); assert it queries `folders`, filters `.not("deleted_at","is",null)`, returns rows, surfaces errors. Run → green.
- [ ] **Step 5:** `tsc --noEmit` clean; run the whole `tests/vault` suite to catch select-shape regressions. **Commit** — `feat(vault): live-folder filtering + useDeletedFolders`

---

### Task 3: Folder delete/restore hooks

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useDeleteFolder.ts`, `useRestoreFolder.ts`
- Test: `apps/desktop/tests/vault/useDeleteFolder.test.tsx`

- [ ] **Step 1 (TDD):** Test first — mirror `apps/desktop/tests/vault/useReleaseLock.test.tsx` (the RPC-hook test pattern): `useDeleteFolder().run(folderId)` calls `client.rpc("pdm_delete_folder", { p_folder_id: folderId })`, returns true on success; on error returns false and exposes a friendly error (the SQL's "contains N file(s)" message must pass through verbatim — it's the UI copy). Same for `useRestoreFolder` → `pdm_restore_folder`.
- [ ] **Step 2:** Implement both hooks by copying `useDeleteFile.ts` / `useRestoreFile.ts` exactly (same loading/error/run shape), only the RPC name + param differ.
- [ ] **Step 3:** Tests green; tsc clean. **Commit** — `feat(vault): useDeleteFolder/useRestoreFolder hooks`

---

### Task 4: Sync ledger module

**Files:**
- Create: `apps/desktop/src/modules/vault/data/sync-ledger.ts`
- Test: `apps/desktop/src/modules/vault/data/__tests__/sync-ledger.test.ts`

- [ ] **Step 1 (TDD):** The ledger is a pure-core + thin-IO module so the logic tests don't need Tauri. Test the pure core:

```ts
import { describe, expect, it } from "vitest";
import { classifyMissing, emptyLedger, recordEntry, removeEntry, parseLedger } from "../sync-ledger";

describe("sync-ledger core", () => {
  it("records and removes entries by normalized relpath", () => {
    let l = recordEntry(emptyLedger(), "Chassis/frame.sldprt", "abc");
    expect(l.entries["chassis/frame.sldprt"]).toMatchObject({ sha256: "abc" });
    l = removeEntry(l, "CHASSIS/frame.sldprt");
    expect(Object.keys(l.entries)).toHaveLength(0);
  });
  it("parseLedger tolerates corrupt input (safe empty)", () => {
    expect(parseLedger("not json").entries).toEqual({});
    expect(parseLedger('{"entries": 5}').entries).toEqual({});
    expect(parseLedger('{"entries":{"a":{"sha256":"x","recordedAt":"t"}}}').entries.a!.sha256).toBe("x");
  });
  it("classifyMissing: only in-vault + in-ledger + missing-locally counts", () => {
    const ledger = recordEntry(emptyLedger(), "a/x.sldprt", "s1");
    // present locally → not deleted
    expect(classifyMissing(ledger, "a/x.sldprt", true)).toBe("present");
    // missing + in ledger → locally deleted
    expect(classifyMissing(ledger, "a/x.sldprt", false)).toBe("locally-deleted");
    // missing + NOT in ledger → never downloaded
    expect(classifyMissing(ledger, "a/y.sldprt", false)).toBe("never-downloaded");
  });
});
```

- [ ] **Step 2:** Implement. Pure core: `interface SyncLedger { entries: Record<string, { sha256: string; recordedAt: string }> }` with keys passed through `normalizePathForCompare` (import from `./local-match`); `recordEntry`/`removeEntry` return new objects; `parseLedger(text)` returns `emptyLedger()` on any parse/shape error; `classifyMissing(ledger, relPath, presentLocally)` returns `"present" | "locally-deleted" | "never-downloaded"`. `recordedAt` is `new Date().toISOString()`.
  IO half: `loadLedger(vaultId): Promise<SyncLedger>` / `saveLedger(vaultId, ledger): Promise<void>` reading/writing `sync-ledger-<vaultId>.json` under `%LOCALAPPDATA%/Helios` — use `@tauri-apps/plugin-fs` `readTextFile`/`writeTextFile` with `{ baseDir: BaseDirectory.AppLocalData }`... CHECK how the repo resolves `%LOCALAPPDATA%\Helios` elsewhere (the bridge writes `bridge.json` there from Rust). If `BaseDirectory.AppLocalData` resolves to the app-identifier dir rather than `Helios`, that is FINE — the ledger just needs a stable per-machine home outside the vault root; use `BaseDirectory.AppLocalData` and note the actual path in a comment. All IO is best-effort: load failure → `emptyLedger()`, save failure → console.warn (never throw into the sync pass).
- [ ] **Step 3:** Tests green; tsc clean. **Commit** — `feat(vault): sync ledger (local-materialization record for deletion detection)`

---

### Task 5: `ensureLocalFolderTree` + materialization wiring

**Files:**
- Create: `apps/desktop/src/modules/vault/data/ensureLocalFolderTree.ts`
- Test: `apps/desktop/src/modules/vault/data/__tests__/ensureLocalFolderTree.test.ts`
- Modify: `apps/desktop/src/modules/vault/data/useAutoSync.ts` (start of `run`, after the early-return guards)
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` (new effect near the reaper wiring, ~line 124)

- [ ] **Step 1 (TDD):** Pure path computation + injected mkdir for testability:

```ts
// ensureLocalFolderTree.ts
import { mkdir } from "@tauri-apps/plugin-fs";
import type { Folder } from "./types";
import { folderPath } from "./folder-paths";

/** Every live folder's local absolute path, deepest paths included (mkdir
 *  recursive makes parents, so we only need leaf-most coverage — but emitting
 *  all is simpler and idempotent). Pure; exported for tests. */
export function localFolderPaths(folders: Folder[], vaultRoot: string): string[] {
  return folders
    .map((f) => folderPath(f.id, folders))
    .filter((p) => p !== "")
    .map((p) => `${vaultRoot}/${p}`);
}

/** Materialize the vault's folder tree under vaultRoot. Both download modes
 *  call this so the scaffolding always exists locally, even for empty
 *  folders. Idempotent + best-effort: an EEXIST or permission failure on one
 *  dir never blocks the others. */
export async function ensureLocalFolderTree(folders: Folder[], vaultRoot: string): Promise<void> {
  for (const p of localFolderPaths(folders, vaultRoot)) {
    try {
      await mkdir(p, { recursive: true });
    } catch {
      // exists / permission — fine; next sync retries.
    }
  }
}
```

Test `localFolderPaths` only (pure): nested folders produce `root/parent/child`; sanitized names (a folder literally named `..`) can't escape root (assert path contains `__` not `..` — `folderPath` sanitizes); deleted folders aren't passed in by callers (callers feed `useFolders` data, already filtered) — assert the function maps exactly what it's given.
- [ ] **Step 2:** Wire into `useAutoSync.run` right after `guardedSet((s) => ({ ...s, busy: true }));` (~line 133): `await ensureLocalFolderTree(folders, vaultRoot);` (folders/vaultRoot are already in scope + deps). Add to the hook's header comment that the pass also materializes folder scaffolding.
- [ ] **Step 3:** Manual-mode + first-load coverage — in BrowseScreen, next to the reaper wiring:

```tsx
  // Materialize the vault folder scaffolding locally in BOTH download modes —
  // empty folders included — so the local tree always mirrors the vault
  // (spec 2a). Auto mode also runs this per sync pass; this effect covers
  // manual mode and the time before the first pass.
  useEffect(() => {
    if (!vaultFolderPath || !folders || folders.length === 0) return;
    void ensureLocalFolderTree(folders, vaultFolderPath);
  }, [folders, vaultFolderPath]);
```

- [ ] **Step 4:** Tests green; tsc clean; `vitest run tests/vault` green. **Commit** — `feat(vault): materialize full folder tree locally in both download modes`

---

### Task 6: Ledger recording at every materialization point

**Files:**
- Modify: `apps/desktop/src/modules/vault/data/useAutoSync.ts` (worker success, ~line 220)
- Modify: `apps/desktop/src/modules/vault/data/useBulkDownload.ts` (per-file success)
- Modify: `apps/desktop/src/modules/vault/components/RowActions.tsx` (the manual per-row Download / Get Latest success paths)
- Modify: `apps/desktop/src/modules/vault/data/useCheckIn.ts` (after successful RPC)
- Modify: `apps/desktop/src/modules/vault/data/useAddLocalFile.ts` (after successful RPC)
- Modify: `apps/desktop/src/modules/vault/data/useDeletedFileReaper.ts` (after successful remove)

- [ ] **Step 1:** Add a tiny convenience in `sync-ledger.ts`:

```ts
/** Load-modify-save in one call. Serialized per vault via a module-level
 *  promise chain so concurrent download workers can't interleave RMW cycles
 *  and drop each other's records. Best-effort like all ledger IO. */
const chains = new Map<string, Promise<void>>();
export function ledgerRecord(vaultId: string, relPath: string, sha256: string): Promise<void> { /* chain-serialized loadLedger → recordEntry → saveLedger */ }
export function ledgerRemove(vaultId: string, relPath: string): Promise<void> { /* same with removeEntry */ }
```

- [ ] **Step 2:** Call sites (each needs `vaultId` + the vault-relative path; both are derivable where noted — READ each file to find the success point):
  - `useAutoSync` worker, in the `if (ok)` branch: the task needs `relPath` + the file's `vault_id` — extend the `Task` type with `{ relPath: string; vaultId: string }` populated during partitioning (`vaultRelativePath(file, folders)`, `file.vault_id`), then `void ledgerRecord(t.vaultId, t.relPath, t.sha);`
  - `useBulkDownload`: after each successful per-file download (it already computes the dest from folders — derive relpath with `vaultRelativePath`).
  - `RowActions.tsx`: the per-row Download/Get-Latest buttons ultimately call the download hook; record on success the same way (the component has `file`, `folders` props in scope).
  - `useCheckIn`: after the RPC succeeds — callers pass the file + its local path; the hook has the sha. If file/folders aren't in scope inside the hook, record at the hook's call sites in `RowActions.tsx`/`BulkActionBar.tsx` instead — implementer picks the layer where `(vaultId, relPath, sha)` are all naturally available, ONE layer only, no double-recording.
  - `useAddLocalFile`: after `pdm_add_and_lock` succeeds: `void ledgerRecord(vaultId, local.relativePath, sha);`
  - `useDeletedFileReaper`: after a successful `remove()`: `void ledgerRemove(vaultId, rel)` — the reaper computes `vaultRelativePath(f, folders)` already (`key`); it needs `vaultId` added to its input (BrowseScreen passes `vaultId`).
- [ ] **Step 3:** tsc clean; full `tests/vault` suite green (existing tests must not break — ledger calls are fire-and-forget `void`). **Commit** — `feat(vault): record local materialization in the sync ledger`

---

### Task 7: Deletion detection + propagation (the third bucket)

**Files:**
- Create: `apps/desktop/src/modules/vault/data/local-delete-events.ts` (copy the tiny pub/sub shape of `data/lock-events.ts`)
- Modify: `apps/desktop/src/modules/vault/data/useAutoSync.ts` (partition loop ~lines 151–182)
- Test: extend `apps/desktop/src/modules/vault/data/__tests__/sync-ledger.test.ts` or new partition test if the logic is extracted pure

- [ ] **Step 1:** `local-delete-events.ts`: `notifyLocalDeleteBlocked(fileNames: string[])` + `onLocalDeleteBlocked(cb)` — mirroring `lock-events.ts` exactly.
- [ ] **Step 2:** In `useAutoSync`, the hook gains inputs `{ vaultId: string | null, client }` — NO: keep the hook self-contained instead: `const client = useSupabaseClient();` inside, and add `vaultId: string | null` to the input object (BrowseScreen/VaultSyncSection pass `vaultId`). In `run`'s partition loop, BEFORE the `m.local && readonly` hold-back check, insert the third bucket (the ledger is loaded ONCE per pass before the loop: `const ledger = vaultId ? await loadLedger(vaultId) : emptyLedger();`):

```ts
      // Third bucket (spec 2c): the vault has it, the ledger says WE
      // materialized it locally, but the scan can't find it ⇒ the user
      // deleted it locally (possibly in File Explorer).
      if (vaultId && m.status === "vault-only") {
        const rel = vaultRelativePath(file, folders);
        if (classifyMissing(ledger, rel, false) === "locally-deleted") {
          if (myLocks.has(file.id)) {
            // …but locked-by-me files were `continue`d above, so this branch
            // is only reachable when NOT locked by me — see note below.
          }
          // Not checked out → re-download (fall through to the task push) and
          // warn once: refreshing the ledger sha below means the next pass
          // sees it as a fresh materialization, not a repeat deletion.
          deleteBlocked.push(file.name);
        }
      }
```

  **Ordering note (important):** the existing loop `continue`s on `myLocks.has(file.id)` at the top — the propagation case (deleted locally AND locked by me) must be handled THERE. Restructure the top of the loop:

```ts
      if (myLocks.has(file.id)) {
        // Locked by me. Normally skip (don't clobber my edits) — but if the
        // ledger shows I materialized it and it's now gone from disk, I
        // deleted my checked-out copy: propagate as a soft-delete (spec 2c).
        if (vaultId) {
          const rel = vaultRelativePath(file, folders);
          const m0 = matchLocal(file, localFiles, versionsByFileId, folders);
          if (!m0.local && classifyMissing(ledger, rel, false) === "locally-deleted") {
            toPropagate.push({ fileId: file.id, name: file.name, rel });
          }
        }
        skipped++;
        continue;
      }
```

  After the worker pool completes (inside the `isCurrent()` commit block), execute propagations sequentially:

```ts
        for (const p of toPropagate) {
          if (!isCurrent()) break;
          const { error } = await client.rpc("pdm_delete_file", { p_file_id: p.fileId });
          if (!error) {
            await ledgerRemove(vaultId!, p.rel);
            propagated.push(p.name);
          }
        }
        if (propagated.length > 0) notifyLocalDeletesPropagated(propagated); // second event in local-delete-events
        if (deleteBlocked.length > 0) {
          // Refresh ledger stamps so each deletion warns once, then notify.
          for (const name of deleteBlocked) { /* ledgerRecord happens naturally when the re-download lands (Task 6's worker recording) */ }
          notifyLocalDeleteBlocked(deleteBlocked);
        }
```

  (Define `notifyLocalDeletesPropagated`/`onLocalDeletesPropagated` alongside the blocked event — the success toast needs it.) The blocked files' ledger entries are refreshed by the re-download's own `ledgerRecord` — no extra write needed; verify that ordering holds (download happens in the same pass).
  The propagation must also trigger the existing refetch machinery — call `onCompleteRef.current?.()` when `propagated.length > 0` even if `downloaded === 0`.
- [ ] **Step 3:** Extract anything hard to test inline (e.g. a pure `partitionFile(...)` helper) only if the implementation gets unwieldy; otherwise cover via the ledger's `classifyMissing` tests (already done) + a focused hook test if feasible. Explicitly verify (test or trace in the report): a blocked file is BOTH warned about AND pushed as a download task in the same pass, and the re-download's `ledgerRecord` refreshes the stamp so the next pass classifies it "present" (warn-once semantics). Do NOT destabilize the generation/abort machinery — all new state writes go through the existing `isCurrent()` guards.
- [ ] **Step 4:** tsc clean; `tests/vault` green. **Commit** — `feat(vault): propagate local deletions of checked-out files; block + warn otherwise`

---

### Task 8: Warnings — banner + OS notification

**Files:**
- Modify: `apps/desktop/package.json` (add `"@tauri-apps/plugin-notification": "^2.0.0"`; run `pnpm install`)
- Create: `apps/desktop/src/modules/vault/components/LocalDeleteBanner.tsx`
- Create: `apps/desktop/src/modules/vault/data/notify.ts`
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` (mount banner next to `UnmatchedFilesBanner`)

- [ ] **Step 1:** `notify.ts` — thin wrapper: `export async function osNotify(title: string, body: string)`: `isPermissionGranted()` → if not, `requestPermission()` → if granted, `sendNotification({ title, body })`; silent catch (spec: permission denied ⇒ banner only). Import from `@tauri-apps/plugin-notification`.
- [ ] **Step 2:** `LocalDeleteBanner.tsx` — subscribes to BOTH events from `local-delete-events.ts`:
  - blocked: accumulates names into a dismissible amber banner styled like `UnmatchedFilesBanner` (read it; reuse its visual language): "`frame.sldprt` was deleted locally but isn't checked out — restored from vault. Check out first to delete." (n>1: list). Fires `osNotify("Helios Vault", "Please check out first to delete — N file(s) restored from vault.")` once per event batch.
  - propagated: transient success line (auto-dismiss ~6s): "Moved to Deleted: `bracket.sldprt`" + `osNotify` mirror.
  Dismiss buttons clear the respective lists.
- [ ] **Step 3:** Mount `<LocalDeleteBanner />` directly under `<UnmatchedFilesBanner …/>` in BrowseScreen.
- [ ] **Step 4:** tsc clean (the new npm package must be installed first or tsc fails on the import). **Commit** — `feat(vault): local-delete warnings (in-app banner + OS notification)`

---

### Task 9: Reaper extension — clean up local dirs of deleted folders

**Files:**
- Modify: `apps/desktop/src/modules/vault/data/useDeletedFileReaper.ts`
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` (pass `deletedFolders`)

- [ ] **Step 1:** Reaper input gains `deletedFolders: Folder[] | null | undefined` and `vaultRoot: string | null` and `allFolders: Folder[]` (live + deleted both needed for path computation — note: `folderPath` walks `parent_id` through the supplied array, so pass `[...(folders ?? []), ...(deletedFolders ?? [])]` as the lookup set so a deleted child under a live parent resolves). After the file-removal loop: for each deleted folder, compute its local path and attempt `remove(path, { recursive: false })` — non-recursive so a dir still containing untracked files fails safely (spec: never delete data the vault doesn't own). Sort deleted folders deepest-first (by path segment count) so children go before parents. Best-effort try/catch per dir.
- [ ] **Step 2:** BrowseScreen: `const { data: deletedFolders } = useDeletedFolders(vaultId ?? undefined);` (+ add its refetch to the realtime/poll callbacks where `refetchDeleted` already sits) and thread into the reaper.
- [ ] **Step 3:** tsc clean; `tests/vault` green (reaper has existing tests — extend `useAutoSync.test`-adjacent reaper test if present; `tests/vault/useAutoSync` … check `apps/desktop/tests/vault/` for a reaper test and extend it with one "removes empty deleted-folder dir, leaves non-empty" case using the mocked fs). **Commit** — `feat(vault): reap local dirs of vault-deleted folders (empty-only)`

---

### Task 10: Recycle screen — deleted folders

**Files:**
- Modify: `apps/desktop/src/modules/vault/screens/RecycleScreen.tsx` (111 lines — read fully)

- [ ] **Step 1:** Add a "Folders" section above the files list: rows of deleted folders (name + vault path via `folderPath(f.parent_id, allFoldersLookup)` prefix + deleted-at + Restore button calling `useRestoreFolder`). On restore success: refetch deleted folders, deleted files, live folders. Show batch context subtly: "restores N files deleted with it" if any files share `delete_batch` (`deletedFiles.filter(x => x.delete_batch === f.delete_batch).length` — `delete_batch` must be added to the deleted-files select if `FILE_WITH_LATEST_SELECT`'s `*` doesn't already include it — it does, `*` covers new columns).
- [ ] **Step 2:** tsc clean. **Commit** — `feat(vault): deleted folders in recycle screen w/ batch restore`

---

### Task 11: Reveal in Explorer (Rust command + UI)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/reveal.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (declare module — read how set_readonly is declared)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register in `generate_handler![...]`)
- Create: `apps/desktop/src/modules/vault/data/reveal.ts`
- Modify: `apps/desktop/src/modules/vault/components/FileTable.tsx` (file-name cell)

- [ ] **Step 1:** Rust command (Windows-first per spec; degrade gracefully elsewhere):

```rust
//! Reveal a file in the OS file manager with the file pre-selected.
use std::path::Path;

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("file does not exist locally".into());
    }
    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` opens the parent folder with the file
        // highlighted. Explorer wants backslashes.
        let win = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{win}"))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("reveal not supported on this platform".into())
    }
}
```

  Register `commands::reveal::reveal_in_explorer` in `generate_handler!`.
- [ ] **Step 2:** `reveal.ts`: `export async function revealInExplorer(absPath: string): Promise<boolean>` — `invoke("reveal_in_explorer", { path: absPath })`, returns false on error (console.warn).
- [ ] **Step 3:** FileTable: the file-name cell becomes clickable when the row has a local match (`matchLocal` result is already computed per row — read the row renderer): name renders as a button (`title="Reveal in File Explorer"`, hover underline + cursor-pointer) calling `revealInExplorer(m.local.absolutePath)`. No local copy → plain text as today. Don't break the existing row `onSelect` — stopPropagation on the name click.
- [ ] **Step 4:** `cargo check` inside `apps/desktop/src-tauri` compiles; tsc clean. **Commit** — `feat(vault): reveal-in-explorer (rust command + name-click + util)`

---

### Task 12: Context menu expansion

**Files:**
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` (context-menu builder, ~line 642)

- [ ] **Step 1:** Extend the folder branch of the builder. Existing: one Download action. Add (in order):
  - `New folder…` → opens the existing prompt but parented at the right-clicked folder: add state `promptParent: FolderId | null` set when opening from the menu; `handlePromptSubmit` uses `promptParent ?? selectedFolder`. (Reset `promptParent` to null when the prompt closes.)
  - `Copy vault path` → `navigator.clipboard.writeText(folderPath(folder.id, folders ?? []))` (clipboard API works in the Tauri webview).
  - `Reveal in Explorer` → `revealInExplorer(\`${vaultFolderPath}/${folderPath(folder.id, folders ?? [])}\`)` — disabledReason "No local folder set" when `!vaultFolderPath`.
  - `Delete folder` (danger: true) → gating: count live descendant files (the builder already has `descendantFiles.length`); if 0 → enabled for `canEdit`; if >0 → enabled only when the user is vault-admin (use the EXISTING per-vault admin hook `useIsVaultAdmin(vaultId)` from `useVaultRole.ts` — do NOT author a new hook; union with the global `isAdmin` like `canEdit` does), else `disabledReason: "Contains files — admins only (or empty it first)"`. Confirm dialog (reuse the app's ConfirmDialog component — search `components/ConfirmDialog` usage in the codebase, it exists in tests) with copy: "Move '<name>' and everything in it to Deleted? (N files)". On confirm → `useDeleteFolder().run(id)` → success: `refetchFolders(); refetchAllFiles(); refetchDeleted(); rescan();` + if the deleted folder was `selectedFolder`, reset it to null. Failure: surface `friendlyPgError`-mapped message.
  - Files branch additions: `Delete N file(s)` (danger) — enabled when every selected file is deletable by the current user (locked-by-me or admin; compute from `locks` like BulkActionBar does — read its delete gating and mirror), with confirm; `Copy local path` (single file with local match; disabledReason otherwise), `Copy name`, `Reveal in Explorer` (single file with local match).
- [ ] **Step 2:** tsc clean; existing FolderTree/BrowseScreen tests green. **Commit** — `feat(vault): expanded right-click menus (delete/copy/reveal/new-folder)`

---

### Task 13: Drag-and-drop import

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useVaultDropImport.ts`
- Create: `apps/desktop/src/modules/vault/data/drop-target.ts` (pure hit-test helper)
- Test: `apps/desktop/src/modules/vault/data/__tests__/drop-target.test.ts`
- Modify: `apps/desktop/src/modules/vault/components/FolderTree.tsx` (add `data-folder-id` attrs + drop-highlight class hooks)
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx` (mount the hook + progress/result UI)
- Modify: `apps/desktop/src/modules/vault/data/useAddLocalFile.ts` (optional `targetPrefix` param)

- [ ] **Step 1 (TDD):** `drop-target.ts` pure helper:

```ts
/** Resolve the vault folder under a screen point. Walks up from the hit
 *  element looking for [data-folder-id]; "" (vault root) and missing both
 *  map to the fallback. Pure given an injected elementFromPoint. */
export function resolveDropFolder(
  x: number, y: number,
  fallback: string | null,
  elementFromPoint: (x: number, y: number) => Element | null = (a, b) => document.elementFromPoint(a, b),
): string | null
```

Test with a fake DOM-ish object graph (elements with `getAttribute`/`parentElement`) — found id, nested child of tagged element, nothing tagged → fallback.
- [ ] **Step 2:** `useAddLocalFile`: add optional third param `targetPrefix?: string` to `run` — when provided, the relativePath used for hierarchy + naming becomes `` `${targetPrefix}/${local.relativePath}` `` (prefix is a vault-folder path of UNSANITIZED DB folder names, slash-joined). Build a helper `folderNamePath(folderId, folders)` (in `folder-paths.ts`, exported, NO sanitization — raw DB names for `ensureFolderHierarchy` matching) — document loudly that it must never be used for filesystem paths.
- [ ] **Step 3:** `useVaultDropImport.ts`: registers `getCurrentWebview().onDragDropEvent` (import from `@tauri-apps/api/webview`) while mounted; only active when `enabled` (Browse mounted + `canEdit`). On `over`: `setHover(resolveDropFolder(position.x, position.y, selectedFolder))` (positions are physical pixels — divide by `window.devicePixelRatio` before hit-testing; verify behavior at runtime and leave a comment). On `drop`: for each path, `stat` via plugin-fs (`stat`) — directories walked with `readDir` recursively (collect `{ absolutePath, relativePath }` preserving structure under the dropped dir's name); files → single entry. Synthesize the `LocalFile` arg minimally — READ `useLocalFolderScan.ts`'s `LocalFile` interface first and fill required fields (`sha256: null`-equivalent so `useAddLocalFile` hashes lazily; `sizeBytes` from stat). Run sequentially through `useAddLocalFile.run(vaultId, synthesized, folderNamePath(targetFolderId, folders))` with per-item results `{ name, ok, error? }`, abortable on unmount (AbortController checked between items, mirroring BulkActionBar). Expose `{ hoverFolderId, importing, results, clearResults }`.
- [ ] **Step 4:** FolderTree: each folder row element gains `data-folder-id={folder.id}`; the tree's container gets `data-folder-id=""` (vault root). Add a `dropHoverId` prop — matching row gets a gold ring class (`ring-1 ring-asu-gold bg-asu-gold/10`). Keep diff minimal — FolderTree is 688 lines; touch only the row className + props.
- [ ] **Step 5:** BrowseScreen: mount the hook (enabled when `canEdit && vaultId`), pass `hoverFolderId` into FolderTree, render a compact import progress/result strip (reuse the visual style of BulkActionBar results) with per-item errors + a dismiss. On batch completion: `refetchFolders(); refetchAllFiles(); refetchFiles(); refetchLocks(); rescan();`.
- [ ] **Step 6:** drop-target tests green; tsc clean; `tests/vault` green. **Commit** — `feat(vault): drag-and-drop import with folder targeting`

---

### Task 14: Full verification + integration smoke

- [ ] **Step 1:** `pnpm --filter @helios/desktop exec vitest run` (FULL suite) + `pnpm --filter @helios/desktop exec tsc --noEmit` + `cargo check` in `src-tauri`. All green; any pre-existing failure documented as such.
- [ ] **Step 2:** Report the deploy steps that remain manual: apply `20260606000000_pdm_folder_soft_delete.sql` to the live Supabase project (Management API; record in `supabase_migrations.schema_migrations`).
- [ ] **Step 3:** Manual smoke checklist (with the migration applied):
  1. Create folder on machine A → appears as empty local dir on machine B in BOTH modes.
  2. Editor right-click-deletes an empty folder → gone from tree, in Recycle "Folders"; restore → back.
  3. Editor attempts delete of non-empty folder → disabled w/ reason; admin → confirm → folder + files in Recycle; restore folder → exactly those files return; a file deleted separately beforehand stays deleted.
  4. Auto mode: Explorer-delete a checked-out file → next pass moves it to Deleted + toast; Explorer-delete a non-checked-out file → restored + banner + OS toast (once).
  5. Drag 2 files + 1 folder from Explorer onto a tree folder → added as drafts (checked out), hierarchy created, progress strip shows results.
  6. Click a synced file's name → Explorer opens with the file selected; vault-only file name is plain text.
  7. Right-click file → Copy name / Copy local path / Delete (lock-gated) all behave.

## Out of scope (per spec)

Rename/move, folder-level permissions, FS-watcher detection, manual-mode deletion detection, hard deletes, macOS shell-extension work.
