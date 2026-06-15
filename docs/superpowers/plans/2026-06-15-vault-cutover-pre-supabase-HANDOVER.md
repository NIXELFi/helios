# Vault Cutover — Pre-Supabase Handover

**Date:** 2026-06-15
**Branch:** `fix/vault-cutover-pre-supabase`
**Base:** `main` @ v4.3.7
**Goal:** July-1 production cutover — Helios Vault becomes the FSAE team's
source of truth for all CAD, replacing SolidWorks PDM.

This branch carries every cutover fix that needs **no Supabase change**. The
DB-side fixes are deliberately *not* applied here — they need a live token and a
validatable stack (this machine has no Docker). Read the companion audit report
first: `docs/superpowers/plans/2026-06-15-vault-cutover-audit.md`.

---

## Branch contents (commits, oldest first)

| Commit | What |
| --- | --- |
| `c95902d` | docs: the 2026-06-15 cutover audit report (verdict, scorecard, plan) |
| `16938d7` | **P0 frontend** — bulk actions, create/move safety, admin profile guard |
| `8341a8e` | **P1 frontend** — correctness fixes that need no DB change |
| `c2001ba` | **bridge Rust** — `/checkin` lock-check, `/cancel-checkout` restore |
| _(this doc)_ | handover |

## Verification status (all green on this branch)

- `pnpm --filter @helios/desktop typecheck` → clean
- `pnpm --filter @helios/desktop test` → **1512 / 1512 pass** (193 files)
- `cargo check` (apps/desktop/src-tauri, incl. `cfg(windows)`) → clean (exit 0)
- pre-commit physics parity suite → passed on every commit
- **Caveat (not a regression):** the full vitest run emits one *unhandled
  error* — a `setTimeout` in `cfd/results/TrialInspector.tsx:94` firing after
  teardown in a CFD test. It's a cross-test timing artifact in a module this
  branch never touches; that CFD test passes 25/25 in isolation.
- ESLint is not configured in this repo (tsc + vitest + the pre-commit hook are
  the gates).

---

## What shipped (with file:line)

### P0 — cutover blockers (frontend half)
1. **Bulk check-in left files writable** — `BulkActionBar.tsx` `bulkCheckInChanges`
   now `setReadonly(true)` + `flipSwReadonly` after each success. Restores the
   writable-iff-locked invariant; a writable-unlocked file was held back from
   sync forever.
2. **Bulk check-out left files read-only** — `bulkCheckOut` now gets-latest-if-stale
   (rolling the lock back on download failure) then clears read-only.
3. **Bulk cancel just released the lock** — `bulkCancel` is now confirm-gated and
   does release → restore latest → read-only per file; discards never-checked-in
   drafts. Added a confirm dialog.
4. **`useCreateFile` non-atomic create+lock** — on lock failure it no longer
   reports success: best-effort removes the orphan row + surfaces the error.
   (Durable fix = atomic RPC, staged below.)
5. **`useMoveFile`** — drops the OLD path's sync-ledger entry on move (a later
   move-back could otherwise soft-delete the live row) + scopes the `folder_id`
   UPDATE to the active vault.
6. **AdminScreen** — Edit user disabled in per-vault scope (the per-vault roles
   RPC doesn't return `display_name`/`subteam`, so saving there blanked them).

### P1 — correctness (frontend)
- `useMyRole` — reports only the GLOBAL role (dropped the `?? rows[0]` per-vault
  fallback that leaked edit affordances cross-vault). Per-vault edit rights come
  from `useCanEditVault` / `useIsVaultAdmin`.
- `useAutoSync` — reconciliation reads the **live** lock set (`myLocksLiveRef`),
  not the start-of-pass snapshot (a checkout mid-pass now stays writable).
- `useDeletedFileReaper` — bail + restore read-only if torn down between clearing
  the bit and `remove()` (no writable-but-unlocked orphan).
- `useActiveVault` — `resetLockOverlay()` on vault switch.
- `useFileProperties` — re-resolves when `version.properties` populates in place.
- `useVaultDropImport` — snapshots vault id/root/folders at import start (a
  mid-import vault switch no longer splits files across vaults).
- `BrowseScreen` — rejects `/`, `\`, `.`, `..`, and control chars in new names.
- `pg-errors` — friendly message for a 23505 revision-number conflict.

### Bridge (Rust)
- `/checkin` — refuses a check-in the caller doesn't hold (`lock.by_me`); avoids
  uploading a blob the RPC then rejects (orphaned object). Returns 409
  `code: not_checked_out`.
- `/cancel-checkout` — restores the vaulted version before re-applying read-only
  (spec 2026-05-30 §4), matching the in-app CancelButton; best-effort, with
  auto-sync's "read-only but differs → refresh" as the fallback.

---

## Deferred on purpose (do NOT silently "fix" without reading this)

- **`readonly === undefined` guard flip** (`useLocalFolderScan` /
  `useAutoSync:277` / `useDeletedFileReaper:125`). The naive `!== true` → `=== false`
  flip the audit suggested trades a sync-stall for a **data-clobber risk** on
  filesystems that don't report the read-only bit (treating "unknown" as "clean"
  lets a genuinely-edited file be overwritten). Windows (the cutover platform)
  reports the bit reliably, so this does not fire in production. Needs a
  platform-aware design, not a one-character flip.
- **WhoHasWhat per-vault force-unlock** (`WhoHasWhatScreen.tsx:97`). The screen is
  cross-vault; a correct fix gates each row on admin-in-*that-row's*-vault, not a
  blanket `isAdmin || isVaultAdmin(active)` (which would show dead buttons on
  other-vault rows). Low impact at a one-vault cutover with a global-admin owner.
- **GetVersion lock-skip** (`RowActions.tsx` `doGet`). Already confirm-gated
  ("local changes will be discarded") and self-heals via reconcile.
- **`set_path_readonly` Unix owner-only mode** — `cfg(unix)`, not relevant to the
  Windows cutover and not compile-checkable here.
- **HKLM overlay post-import presence verify** — install polish.

---

## STAGED FOR THE SUPABASE PASS (needs token + a validatable stack)

Apply per the standing convention (see `2026-06-10-vault-audit-HANDOFF.md`):
**never `supabase db push`** — apply via the Management API / MCP
`apply_migration`, then commit an identical mirror file under
`infra/pdm-supabase/supabase/migrations/`; validate first with
`supabase db reset` locally (needs Docker — not on this machine) and run the
security suite.

1. **P0-4 — recycle name reservation.** `unique(folder_id, name)` and
   `files_top_level_name_uniq` are non-partial, so soft-deleted rows reserve the
   name and `restore_file` / `restore_folder` / `add_and_lock` throw a raw
   `unique_violation`. Plan: replace with partial unique indexes
   `WHERE deleted_at IS NULL`; add a friendly pre-check (or a content-GC purge to
   free names). **First** scan live data for `(folder_id, name)` duplicates
   *including soft-deleted* — the constraint change fails if any exist.
2. **P0-6 — atomic create-locked RPC.** Add `pdm_create_file_locked(vault_id,
   folder_id, name)` that inserts the file row + lock in one transaction
   (model on `pdm_add_and_lock`, minus the version). Then rewire
   `useCreateFile.ts` to call it (replace the two-step insert). The current
   frontend mitigation (no silent success + best-effort orphan delete) holds
   until this lands.
3. **P0-5 — `list_vault_roles` columns.** Add `display_name` + `subteam` via an
   `auth.users` join (this changes the return type → `DROP FUNCTION` then
   recreate, and update the `pdm_list_vault_roles` / `public.pdm_list_vault_roles`
   wrappers). Then re-enable Edit in per-vault scope in `AdminScreen.tsx` (remove
   or relax the `vaultScoped` disable added in P0-5's frontend guard).
4. **P1 backend — audit-swallow.** Remove the
   `BEGIN … EXCEPTION WHEN OTHERS THEN NULL` around the `audit_log` inserts in
   `delete_file` / `restore_file` / `delete_folder` / `restore_folder` so a failed
   audit insert can't produce an invisible delete.
5. **Bug/feature report backend** — apply
   `infra/pdm-supabase/supabase/migrations/20260615000000_support_reports.sql`
   (new `support` schema + `support.reports` table + RLS + `report-attachments`
   bucket), AND **expose the `support` schema** in the project's API settings
   (PostgREST exposed schemas) so the client's `.schema("support")` calls
   resolve. The whole report feature (sidebar button, modal, admin viewer) is
   built and committed but **inert until this is applied** — by design, not a
   bug. Spec/plan: `docs/superpowers/specs/2026-06-15-bug-feature-report-design.md`,
   `docs/superpowers/plans/2026-06-15-bug-feature-report.md`. RLS suite to add:
   reporter inserts/reads own, non-admin can't read others', admin reads/updates
   all, anon denied.

### Supabase verification checklist (audit report §6)
- **Schema-drift diff:** live DDL vs the migration-derived schema (hosted history
  is drifted — many migrations applied via API, not `db push`). Confirm the
  effective `(folder_id, name)` constraint shape (P0-4) and the 2026-06-10
  vault-scoped policies are actually present.
- **RLS live-probe:** cross-vault read/write isolation; `audit_log` cross-vault
  readability (known-backlog: `vault_id` unstamped); storage SELECT sha-scoping.
- **`pdm.refs` reality check:** confirm it's empty/near-empty in prod (drives the
  Where-Used go/no-go).
- **Pre-constraint live dup check** before P0-4 (above).

---

## Invariants to preserve (do not break these)

1. **OS read-only bit = the clean-copy marker.** Writable = checked out by this
   user / possible unsaved edits. Any delete/overwrite path must refuse when
   writable.
2. **RLS resolves file→vault via SECURITY DEFINER helpers** (`pdm.file_vault_id`,
   `pdm.version_vault_id`, `pdm.is_member_in`), never inline subqueries on
   `pdm.files`.
3. **Global role rows (`vault_id IS NULL`) are authoritative in every vault.**
4. **Storage is content-addressed + immutable** (`sha[0:2]/sha`); dedup via
   `pdm_object_exists`, not storage `list()`.
5. `pdm.files.created_by` defaults to `auth.uid()`.
6. `window.confirm` is a no-op in Tauri — use `ConfirmDialog`.

## Resume / re-run the gates

```
# from repo root
cd apps/desktop
pnpm typecheck
pnpm test                 # full suite
pnpm exec vitest run src/modules/vault   # vault only (fast)
cd src-tauri && cargo check
```

## Parity calls still open (PDM Standard baseline)
Where-Used / Contains (non-functional — `pdm.refs` empty; needs SW-file format
work), file/folder rename (not implemented), vault-wide / comment search
(name-only today). See the audit report's scorecard + remediation plan.
