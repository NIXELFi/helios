# Vault Capability Expansion v1 — Handoff (2026-06-05, FINAL)

**Status: ALL 14 plan tasks complete.** Branch **`feat/vault-capabilities`**,
final review APPROVED for merge. Spec:
`docs/superpowers/specs/2026-06-05-vault-capabilities-design.md`. Plan:
`docs/superpowers/plans/2026-06-05-vault-capabilities.md`.

## Shipped

| Plan task | Commit | What |
|---|---|---|
| T1 | `9107010` | Folder soft-delete migration (delete_batch subtree RPCs, role gates). **Applied to live project 2026-06-05** + recorded in schema_migrations. |
| T2–T5 | `505158d` | Live-folder filtering, useDeletedFolders, delete/restore hooks, sync ledger, ensureLocalFolderTree (both modes). |
| T6–T7 | `807521c` | Ledger recording at every materialization point; local-deletion detection: checked-out → soft-delete propagation, else re-download + warn-once events. |
| T8–T9 | `d2a37ca` | LocalDeleteBanner + OS toast (`@tauri-apps/plugin-notification` npm added); reaper removes empty local dirs of deleted folders. |
| T10–T11 | `0ade1fe` | RecycleScreen "Folders" section w/ batch restore; reveal-in-Explorer (Rust `reveal_in_explorer` + FileTable name-click). |
| T12–T13 | `8b79592` | Context menus (new folder anywhere, copy path/name, delete w/ role gating, reveal); drag-and-drop import w/ folder hover-targeting (`useVaultDropImport`, `targetPrefix` on useAddLocalFile). |
| Hotfix | `e418ec6` | Live-testing bugs: vault-switch race built vault A's scaffolding in vault B's dir (guards in BrowseScreen effect + useAutoSync + reaper); `explorer /select` raw_arg quoting (paths w/ spaces opened wrong folder). |
| Review nits | (final commit) | Ledger-key sanitization parity in useAddLocalFile; reaper vault-switch guard. |

**Verification:** full desktop suite 994/994 (128 files), `tsc --noEmit` clean,
Rust parity suite green on every commit. Final whole-branch review approved —
the "nothing is ever falsely deleted" invariant verified by construction
(propagation requires ledger hit AND missing-locally AND my-lock).

## Remaining manual QA (smoke checklist — plan T14 step 3)

1. Create folder on machine A → empty local dir appears on machine B (both modes). *(partially verified live — incl. the vault-switch fix)*
2. Editor deletes empty folder / admin deletes non-empty / restore brings back exactly the batch.
3. Explorer-delete checked-out file → Deleted screen + toast; non-checked-out → restored + banner + toast (once).
4. Drag files + a folder from Explorer onto a tree folder — **verify hover hit-testing on a HiDPI/scaled monitor** (devicePixelRatio conversion flagged in `useVaultDropImport.ts`).
5. Reveal-in-Explorer on names with spaces. *(fixed e418ec6 — needs a Tauri rebuild to test, the running dev exe predates the Rust change)*

## Known minor follow-ups (non-blocking, from final review)

- Context-menu/BulkActionBar file-delete gating uses GLOBAL admin (existing
  pattern) — consider aligning to per-vault `useIsVaultAdmin`.
- `restore_folder`'s ancestor re-anchor loop assumes acyclic parent chains
  (tree invariant; no explicit cycle guard).
- Deferred by design: rename/move (SolidWorks references), folder-level
  permissions, FS-watcher detection, manual-mode deletion detection.

## Gotchas (unchanged)

- Never `git add -A` (stray `worktrees/cfd-analytics` gitlink).
- Pre-commit hook ≈2.5 min/commit — batch commits.
- Folder query-shape changes break supabase-mock chains in ~5 test files.
- Sync ledger lives under `BaseDirectory.AppLocalData`; corrupt ⇒ safe empty.
