# Vault Cutover Audit — 2026-06-15

> Complete bug audit + SolidWorks-PDM **Standard** parity audit of the Helios
> Vault on `main` @ **v4.3.7**, ahead of the **July-1 production cutover** (the
> vault becomes the FSAE team's source of truth for all CAD, replacing
> SolidWorks PDM). Builds on the 2026-06-09/10 audit (`2026-06-10-vault-audit-HANDOFF.md`).

**Method.** 12 Sonnet area-agents read the full vault surface (frontend hooks
/screens/components, `pdm-core`/`pdm-client`/`pdm-sw-parser`, the Tauri
`bridge`/`addin_injector`/commands, the C# SW add-in, the shell-ext, and all 71
Supabase migrations + 19 security tests). Every must-fix finding below was then
**re-verified by hand against the cited code** (marked ✓verified). Parity is
rated against **SolidWorks PDM Standard** — the workflow/state engine, advanced
configuration-specific data cards, replication, and the web client are
**out-of-scope** by the design spec and do not count as gaps.

Raw counts: **52 candidate bugs** (0 critical / 18 high / 17 medium / 17 low)
and **40 parity gaps** (3 finder-rated blockers). After triage + PDM-Standard
recalibration the actionable picture is below.

---

## 1. Verdict — GO-WITH-FIXES (currently NO-GO for July 1)

There is **no unconditional critical data-loss bug** — server-side locking
(partial unique index + `FOR UPDATE` RPCs), version monotonicity, SHA-verified
downloads, and the SECURITY-DEFINER RLS model are all sound. **But** there is a
tight cluster of **HIGH correctness bugs that will bite a 20-person team within
the first days of go-live**, plus parity gaps that range from blocker-ish to
important. **Cutover is not safe until the P0 list (§2) is fixed.**

After P0, the vault is a viable **"Standard-core-minus-references-and-rename"**
PDM. Two product decisions must be made explicitly before go-live:

- **Where-Used / Contains is non-functional today** (`pdm.refs` is empty — both
  the modern UnQLite format *and* legacy CFB UTF-16LE path extraction fail). If
  the team needs where-used on day 1, that's a **blocker**; if they can live
  without it initially, it's a tracked gap.
- **File/folder rename is not implemented.** The only rename path is
  delete + re-add — which currently trips the recycle name-reservation bug
  (P0-4). Decide whether rename is acceptable as delete+re-add for go-live.

---

## 2. Cutover blockers (P0 — must fix before July 1)

All ✓verified against the code during triage.

| # | Fix | Files | Effort |
|---|-----|-------|--------|
| P0-1 | **Bulk check-in leaves files writable** — `bulkCheckInChanges` releases the lock but never `setReadonly(dest,true)`. Breaks writable-iff-locked; auto-sync then treats the file as an unsaved edit and *holds it back from sync permanently*. Add `setReadonly(true)` after each success, mirroring `CheckInButton`. | `components/BulkActionBar.tsx:148-201` | S |
| P0-2 | **Bulk check-out leaves files read-only** — `bulkCheckOut` acquires the lock but never downloads-if-stale or `setReadonly(false)`/`flipSwReadonly`. Holder can't edit in SW/Explorer. Mirror `CheckOutButton`. | `components/BulkActionBar.tsx:235-258` | S |
| P0-3 | **Bulk cancel = lock release only** — no confirm, no re-download of latest, no `setReadonly(true)`. Leaves files **writable + stale → held back forever** with no recovery in the bulk UI. Implement full single-file `CancelButton` logic, or disable bulk-cancel until it's safe. | `components/BulkActionBar.tsx:260-280` | M |
| P0-4 | **Recycle name reservation** — `unique(folder_id,name)` (and the top-level `files_top_level_name_uniq`) are **non-partial**: soft-deleted rows keep their name reserved, so `restore_file`/`restore_folder`/`add_and_lock` hit a raw `unique_violation` whenever a same-name live file exists → file becomes **un-restorable / un-re-addable** with a cryptic error and no purge to free the name. Make the indexes partial `WHERE deleted_at IS NULL` (verify live data for dup violations first per handoff rule), or add graceful pre-checks. | `migrations/20260507000000:33`, `20260610120000:49-51`, soft-delete RPCs in `20260603100000` & `20260606000000` | M (DB) |
| P0-5 | **`list_vault_roles` drops `display_name`/`subteam`** (6 cols vs `admin_list_users`' 7). In vault scope the Edit dialog pre-fills blank; the `dirty` guard blocks an untouched save, but editing *one* field serialises the other blank field to `null` → **silently wipes the user's real subteam/name** (column shows "—" so it's invisible). Add the two columns via `auth.users` join, or disable Edit in vault scope. | `migrations/20260531000000:276-293`, `screens/AdminScreen.tsx:393-397`, `components/EditUserDialog.tsx:52-56` | S |
| P0-6 | **`useCreateFile` is non-atomic** — `files` insert then a *separate* `locks` insert; on lock failure it only `console.warn`s and returns success, leaving a versionless, unlocked row visible to the whole vault. Replace with an atomic create+lock RPC (model on `pdm_add_and_lock`), or hide the row until the lock is confirmed. | `data/useCreateFile.ts:21-43` | S–M |
| P0-7 | **`useMoveFile` stale ledger + missing vault scope** — records the new ledger path but never `ledgerRemove`s the old one (a later move-back can make auto-sync classify the file as locally-deleted and **soft-delete a live vault file**); and the `.update().eq("id")` has no `.eq("vault_id")` guard (a global admin can re-parent across vaults). Add `ledgerRemove(old)` + `.eq("vault_id", ctx.vaultId)`. | `data/useMoveFile.ts:34-56` | S |

---

## 3. Bug findings by severity (post-triage)

### High → fold into P0 or P1
The seven P0 items above are the verified highs that gate cutover. The
remaining highs are **P1** (fix in the first patch wave; mostly self-healing or
single-vault-safe today):

- **`audit_log` INSERT silently swallowed** in `delete_file`/`restore_file`/
  `delete_folder`/`restore_folder` (`BEGIN…EXCEPTION WHEN OTHERS THEN NULL`).
  A failed audit insert yields invisible deletes in the system of record. Stop
  swallowing. `migrations/20260610110000:125-128`, `20260603100000:143-167`,
  `20260606000000:77-127`. **[P1, S]**
- **`readonly === undefined` treated as writable** — `!== true` guards in
  `useLocalFolderScan.ts:98-106`, `useAutoSync.ts:277`,
  `useDeletedFileReaper.ts:125` permanently hold back stale files on any FS that
  doesn't populate `FileInfo.readonly`. *Windows NTFS does populate it, so the
  July-1 Windows clients are safe* — but change `!== true` → `=== false` for
  Mac/odd-FS robustness. **[P1, S]**
- **`WhoHasWhat` force-unlock hidden for per-vault admins** — gated on global
  `useIsAdmin`; a vault-only admin can't force-unlock from the UI though the RPC
  would accept it. OR in `useIsVaultAdmin(activeVaultId)`. Low impact at cutover
  (one vault, owner is global admin). `WhoHasWhatScreen.tsx:97`. **[P1, S]**
- **`useWhereUsed` returns superseded-parent refs** (no latest-version filter)
  and **`record_refs`/reresolve count soft-deleted files** in basename
  resolution. Both real, both **latent until `pdm.refs` is populated** (empty
  today). `data/useReferences.ts:81-100`; `migrations/20260530120000:57`,
  `20260610200000:29`. **[P1, S–M]**

### Medium (representative — fix opportunistically)
- **`GetVersionButton` forces read-only while you hold the lock** — `doGet()`
  calls `setReadonly(true)` with no lock-held check, so "Get" an old version on a
  checked-out file overwrites edits and leaves it locked-but-read-only. *Gated by
  a confirm dialog and auto-sync re-flips locked-by-me → writable, so it
  self-heals in auto mode* (downgraded from high). Skip `setReadonly` when the
  lock is held. `components/RowActions.tsx:498-516`.
- **Bridge `/cancel-checkout` doesn't restore content** — sets read-only but
  never re-downloads the vaulted version, so edited bytes persist marked "clean"
  (spec §4 requires release→re-download→read-only). Self-heals in auto-sync
  (read-only+differs → stale → refresh); diverges in manual mode.
  `bridge/server.rs:215-241`.
- **Bridge `/checkin` doesn't verify the caller holds the lock** → upload then
  RPC lock-mismatch → orphaned storage blob + opaque 502. Pre-check
  `lock.by_me`. `bridge/server.rs:319-354`.
- **`useMyRole` per-vault fallback leaks cross-vault `canEdit`** — editor in
  vault A sees edit affordances in vault B (mutations still rejected server-side;
  UI/UX only). `data/useMyRole.ts:38-39`, `BrowseScreen.tsx:89-91`.
- **Drop-import vault-switch race** — `runImport` reads `vaultId`/`folders` from
  live refs; switching vaults mid-import routes remaining files to the new vault
  silently. Snapshot at loop start. Multi-vault only.
  `data/useVaultDropImport.ts:94-103,229-230`.
- **`useFileProperties` stale panel** (dep `[version?.id]` misses in-place
  `properties` updates); **reaper writable-orphan window**; **storage INSERT
  not vault-scoped** (content-addressed, low risk); **`record_refs`/
  `restore_version` membership-at-call-time gaps**; **create/move name path
  traversal** (`BrowseScreen.tsx:495-537` accepts `/`,`\`,`..`); **large-drop
  JS-heap OOM** (`useVaultDropImport.ts:257`). See raw output for each.

### Low (17) — polish; none gate cutover
Friendly-error mapping for revision 23505; optimistic-overlay singleton not
reset on vault switch; cross-vault `activeLocks` count; `fetchAllRows`
partial-success dead code; folder-cascade audit rows; RecycleScreen Restore
button shown to non-deleters; HKLM overlay post-import verify; Unix
`set_readonly` widening to group/other; empty-properties re-parse;
multi-config mass props; spotlight/Ctrl+F edge cases. **Note:** the wave-3
backlog item *"`useVaultAccess` `.maybeSingle()`"* is **already fixed** at
v4.3.7 — drop it from the backlog.

---

## 4. SW-PDM Standard parity scorecard

| Capability | Status | Note |
|---|---|---|
| Check-out / check-in / undo (single file) | **Full** | Correct incl. read-only transitions, undo discard+restore, comment prompt |
| Check-out / check-in / undo (**bulk**) | **Divergent** | P0-1/2/3 — broken read-only handling |
| Get Latest / Get Version | **Partial** | Single-file works; bulk doesn't get-latest; no reference recursion |
| Version history & rollback | **Partial** | Rollback solid; **missing author column** in `VersionList`; no open/compare |
| **Where-Used / Contains** | **Missing (non-functional)** | `pdm.refs` empty — parser gap (modern + CFB UTF-16LE); also flat (no recursion), no rename/move survival, no repair UI |
| Data cards / properties | **Partial** | Read-only display only — no write-back, not searchable/sortable. (Templates & config-specific = out-of-scope) |
| Search | **Partial** | In-memory **filename-only**; no vault-wide / comment / property / checked-out-by search |
| Permissions / admin override | **Full*** | admin/editor/viewer (+per-vault) enforced server-side; force-unlock works. Per-folder perms & role tiers = out-of-scope |
| Rename / move / copy / delete | **Partial** | **No rename**; move is admin-only + doesn't update refs + no folder move/copy; delete→recycle→restore works (modulo P0-4); no purge/cold-storage |
| Explorer overlays / context menu / local view | **Partial** | Context menu + tooltip work; **overlays need one-time UAC**; no "Checked out by" Details column; no distinct stale-vs-modified badge |
| Offline / conflict / notifications | **Partial** | Dep-change re-trigger ≈ offline recovery; no explicit queue/retry UI; force-release conflict surfaced; Slack pipeline dark |

\* server-side; client viewer-gating is defence-in-depth only (acceptable for a
desktop app with no public endpoint).

### Parity items to decide before cutover
- **Where-Used**: blocker iff needed day 1 — otherwise tracked. Fixing needs
  real SW-file format work (UnQLite/DEFLATE + UTF-16LE CFB). **[L]**
- **Rename**: real Standard feature, currently absent. Add inline rename
  (lock-holder for files, admin for folders). **[M]**
- **Comment search**: highest-value cheap search win — server `ILIKE` on
  `versions.comment`, no schema change. **[M]**
- **History author column**: one-line add using existing `author_id`. **[S]**
- **Editor file move**: `pdm_move_file` RPC with server-side lock-holder check
  (removes admin-only friction). **[M]**

---

## 5. Ranked remediation plan to cutover

**Wave A — P0 (blockers, ~1–2 days):** P0-1/2/3 bulk read-only trio →
P0-4 recycle partial indexes (verify live dups first) → P0-5 `list_vault_roles`
columns → P0-6 atomic create+lock RPC → P0-7 move ledger+vault guard.

**Wave B — P1 correctness (~1 day):** audit-swallow removal · `readonly`
guard `=== false` · GetVersion lock-held skip · bridge cancel re-download +
checkin lock check · `useMyRole` fallback · per-vault force-unlock gate ·
where-used latest-filter + soft-delete exclusion (before any real check-in run).

**Wave C — parity decisions (scope-dependent):** history author column (S) +
comment search (M) + editor move RPC (M) as the cheap high-value set; then the
**go/no-go calls** on Where-Used (L) and Rename (M).

**Onboarding gate:** make the "Install / repair add-in" (HKLM overlay
registration, one-time UAC) a prominent step so overlays are live before day 1.

---

## 6. Residual risk — verify on the Supabase backend (next pass, needs token)

The audit read repo migrations; the hosted project (`dlmyixonuyckxkknolku`) has
**drifted migration history** (multiple migrations applied via Management API,
not `db push`). Before cutover, against the live DB:

1. **Schema diff** live DDL vs the migration-derived schema — confirm the
   effective `unique(folder_id,name)` shape (P0-4) and all 2026-06-10 vault-scoped
   policies are actually present as the repo claims.
2. **RLS live-probe**: cross-vault read/write isolation, `audit_log` cross-vault
   readability (known-backlog: `vault_id` unstamped), storage SELECT sha-scoping.
3. **Live-data pre-checks** before applying P0-4's partial indexes: scan for
   existing `(folder_id,name)` duplicates incl. soft-deleted (handoff rule).
4. **`pdm.refs` reality check** — confirm it is empty/near-empty in prod (drives
   the Where-Used go/no-go).
5. Confirm the four 2026-06-10 migrations + any since are applied and that no
   policy was left in a reverted state by the CREATE-OR-REPLACE chains.

---

*Audit run: lean Sonnet read pass (12 agents, ~1.1M tok) + Opus hand-verification
of every P0 finding. Full raw findings retained in the workflow output.*
