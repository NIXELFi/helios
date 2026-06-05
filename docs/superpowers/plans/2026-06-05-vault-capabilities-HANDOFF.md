# Vault Capability Expansion v1 — Handoff (2026-06-05)

Status snapshot at hand-off. Work lives on branch **`feat/vault-capabilities`**
(cut from main after the Games-tab merge). Spec:
`docs/superpowers/specs/2026-06-05-vault-capabilities-design.md`. Plan (the
contract for the remaining tasks, with complete code + anchors):
`docs/superpowers/plans/2026-06-05-vault-capabilities.md`.

## Done ✅ (committed, tested, tsc-clean)

| Plan task | Commit | What shipped |
|---|---|---|
| T1 migration | `9107010` | `20260606000000_pdm_folder_soft_delete.sql` — folders gain deleted_at/deleted_by/delete_batch (files gain delete_batch); `pdm_delete_folder` (empty→editor, non-empty→admin, batch-stamped subtree soft-delete, lock release, audit) + `pdm_restore_folder` (batch-exact restore + ancestor re-anchor) + wrappers/grants. **NOT yet applied to the live Supabase project** — see Deploy below. |
| T2 filtering | `505158d` | Folder/VaultFile types gain soft-delete fields; `useFolders` + both `ensureFolderHierarchy` lookups filter `deleted_at is null`; new `useDeletedFolders` + test. |
| T3 hooks | `505158d` | `useDeleteFolder` / `useRestoreFolder` (+ tests) calling the new RPCs; P0001 messages pass through verbatim for UI copy. |
| T4 ledger | `505158d` | `data/sync-ledger.ts` (+ tests): pure core (recordEntry/removeEntry/parseLedger/classifyMissing, normalized keys), best-effort IO under `BaseDirectory.AppLocalData`, chain-serialized `ledgerRecord`/`ledgerRemove` helpers (exist, **not yet called** — that's T6). |
| T5 materialization | `505158d` | `ensureLocalFolderTree` (+ tests); wired into the auto-sync pass AND a manual-mode effect in BrowseScreen — the local tree now mirrors all live vault folders in both modes, empty folders included. |

Verification at `505158d`: vault suites 65 files / 412 tests green; `tsc --noEmit` clean.

## Remaining ⬜ (plan Tasks 6–14 — full instructions in the plan file)

- **T6** ledger recording at the 6 materialization points (useAutoSync worker, useBulkDownload, RowActions, check-in call sites, useAddLocalFile, reaper removal).
- **T7** deletion detection + propagation (the third bucket in useAutoSync; `local-delete-events.ts`; locked-by-me → `pdm_delete_file`; else re-download + warn-once). The riskiest task — respect the generation/abort machinery; plan has the exact restructure.
- **T8** warnings: add npm pkg `@tauri-apps/plugin-notification` (Rust plugin + capability ALREADY present), `notify.ts`, `LocalDeleteBanner` in BrowseScreen.
- **T9** reaper removes empty local dirs of vault-deleted folders (deepest-first, non-recursive).
- **T10** RecycleScreen "Folders" section + batch restore.
- **T11** reveal-in-Explorer (new Rust command `commands/reveal.rs` + registration, `reveal.ts`, FileTable name-click).
- **T12** context-menu expansion (new folder anywhere / copy path / delete w/ role gating via existing `useIsVaultAdmin` / reveal).
- **T13** drag-and-drop import (drop-target helper + `useVaultDropImport` + FolderTree `data-folder-id` + `useAddLocalFile` targetPrefix param).
- **T14** full-suite verification + manual smoke checklist (in plan).

## How to resume

Subagent-driven execution against the plan file, fresh agent per task (or
small batches like T2–T5 were), spec+quality review per task when time
allows. Branch `feat/vault-capabilities`; merge to `main` only after T14.

## Deploy steps (manual, when releasing)

1. Apply `infra/pdm-supabase/supabase/migrations/20260606000000_pdm_folder_soft_delete.sql`
   to project `dlmyixonuyckxkknolku` (Management API `POST /v1/projects/<ref>/database/query`,
   then insert `('20260606000000','pdm_folder_soft_delete')` into
   `supabase_migrations.schema_migrations`). The `games` schema deploy on
   2026-06-05 used the same flow.
2. T8 adds an npm dep — run `pnpm install` after pulling.

## Gotchas discovered during execution

- **Do NOT `git add -A` on this machine**: a registered worktree at
  `worktrees/cfd-analytics` gets staged as an embedded gitlink. Stage paths
  explicitly (`apps/desktop/...`, `infra/...`, `docs/...`).
- Adding `.is("deleted_at", null)` to folder queries required threading a
  `.is()` link through the query-builder mocks in 5 existing test files —
  already fixed; future query-shape changes will hit the same mocks.
- The pre-commit hook runs a ~2.5-minute Rust parity suite on EVERY commit —
  batch commits where sensible.
- The sync ledger lives under `BaseDirectory.AppLocalData` (app-identifier
  dir), intentionally outside the vault root; corrupt/missing ⇒ safe empty.

## Context: what else shipped today (already on main)

- Games tab MVP + full visual polish + standings prefetch (`main`, deployed:
  `games` schema applied + exposed on the live project).
- SDM27E vault cleanup (Brakes/Chassis empty folders removed server-side).
