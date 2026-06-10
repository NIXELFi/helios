# Vault Audit 2026-06-09/10 — HANDOFF

> **For agentic workers + humans:** read this before resuming any Vault (PDM)
> work. It records what the multi-agent audit found, what shipped in waves 1–2,
> how to operate the new test/CI/deploy machinery, the invariants the fixes
> rely on, and the ranked wave-3 backlog.

## Context

Helios Vault (the SolidWorks-PDM-style module) is Sun Devil Motorsports' OSS
competition entry. A 93-agent, 8-dimension audit of `main` (post-v4.3.1) ran on
2026-06-09: every finding was adversarially verified — **52 confirmed**, 11
refuted, 2 feature ideas. Fixes shipped in two waves:

| Wave | Branch | PR | Scope |
| --- | --- | --- | --- |
| 1 | `fix/vault-audit-wave1` | [#9](https://github.com/NIXELFi/helios/pull/9) | 3 criticals, 7 highs, 9 mediums: data safety, RLS isolation, CI security gate, OSS hygiene |
| 2 | `feat/vault-audit-wave2` (stacked on wave 1) | [#10](https://github.com/NIXELFi/helios/pull/10) | Where-Used self-healing + Restore Version (rollback) |

Both PRs are **CI-green** (including the new security suite). Merge #9 first;
GitHub retargets #10 to `main` automatically.

**The hosted database (`dlmyixonuyckxkknolku`) is ALREADY running all four new
migrations** — they were applied via the Management API on 2026-06-10, ahead of
the code merging. This is safe (policy changes don't change API shapes) and
matches this repo's standing practice. The repo migration files are mirrors.

## What shipped (by finding)

### Wave 1 — criticals

1. **Reaper destroyed unsaved local work** (`useDeletedFileReaper.ts`): any
   remote soft-delete hard-removed the local copy, including writable copies
   with unsaved edits. Now only clean **read-only** copies are reaped; writable
   ones are kept and surfaced via `notifyReaperHeldBack` → `LocalDeleteBanner`
   (+ OS toast, warn-once per `vaultId:relPath`).
2. **Cross-vault content download** (storage policy): any role holder could
   read/sign any object. SELECT is now sha-scoped — readable only if a version
   of a file in one of YOUR vaults carries that sha. The check-in existence
   probe moved from storage `list()` to the `pdm_object_exists` definer RPC
   (otherwise cross-vault content dedup breaks — see comments in
   `useCheckIn.ts` / `useAddLocalFile.ts`). INSERT additionally enforces the
   canonical `^[0-9a-f]{2}/[0-9a-f]{64}$` key shape.
3. **Security suite never ran in CI**: `infra/pdm-supabase/tests` (88 cases,
   now 97) was filtered out of both workflows and was silently carrying 3
   failures + the write-isolation regression below. New `pdm-security-tests`
   job in `ci.yml` runs it on every PR against a throwaway local stack.

### Wave 1 — highs/mediums (abridged; see PR #9 for the full list)

- Per-vault **write isolation** restored (`can_edit_in(vault_id)` on
  files/folders/locks inserts — `20260602010000` had regressed it to
  role-anywhere; `can_edit_in` already counts `owner`).
- **Read RLS** member-scoped on files/folders/versions/locks/refs;
  `audit_log` + `user_roles` tightened; `anon` read on `subteams` revoked;
  `pdm.vaults` stays authenticated-readable (vault switcher).
- `delete_file` revalidates the editing role at call time (stale-lock auth).
- Checkout **rolls back** (releases the lock) if the latest download fails —
  never leaves a stale file writable (`RowActions.tsx` + test).
- Bridge `/get-latest` refuses to overwrite a writable local copy
  (`dirty_local_copy` structured error, `bridge/server.rs`).
- Perf: `files_by_vault` index (BrowseScreen was a full Seq Scan), all pdm FK
  indexes, `versions_by_sha` (needed by the storage policy), `user_roles` PK
  restored, top-level `(vault_id, name)` uniqueness.
- Dead/unmounted vault root no longer scans as "empty vault"
  (`useLocalFolderScan.ts` `hadFilesRef` guard — empty would read as a mass
  local delete downstream).
- Bulk delete: honest soft-delete copy, per-file failures named + kept
  selected, per-vault admin gating (`useIsVaultAdmin`).
- Where-Used hides soft-deleted parents; Contains renders soft-deleted
  children as broken refs (`useReferences.ts`).
- `release.yml` gained a Typecheck gate; add-in injector got PowerShell
  single-quote escaping + post-import HKLM verification.
- OSS: `LICENSE` (MIT) created, README rewritten for v4.3.1 (four modules +
  honest Vault section), wiki `09-modules-vault-logs.md` corrected,
  `CONTRIBUTING.md` + `SECURITY.md` added.

### Wave 2

- **Refs re-resolution** (`20260610200000`): triggers on `pdm.files` re-run
  `record_refs`' unique-basename rule when a file is created, and pin
  `child_version_id` when its first version lands; one-time backfill included.
  Where-Used now self-heals when parts arrive after their assemblies.
- **`pdm.restore_version(file, version)`**: SW-PDM rollback as a check-in of
  old content — requires the caller's active lock, releases it, creates the
  next version with the same sha (zero re-upload), carries `properties` (data
  card) + refs to the new version, skip-unchanged path mirrors `check_in`.
  UI: `RestoreVersionButton` on non-latest rows in `FileDetailPanel`
  (editors only, confirm-gated, read-only local materialization after).

## Operating the machinery

### Run the backend security suite locally

```bash
cd infra/pdm-supabase
supabase start                      # applies ALL migrations from scratch
# one-time per stack: mark it a test DB (pdm.test_reset() refuses otherwise)
docker exec -e PGPASSWORD=postgres supabase_db_pdm-supabase \
  psql -U supabase_admin -d postgres -h 127.0.0.1 \
  -c "ALTER DATABASE postgres SET app.environment = 'test';"
docker restart supabase_rest_pdm-supabase   # PostgREST reads the GUC at connect
eval $(supabase status -o env | grep -E "^(API_URL|SERVICE_ROLE_KEY|ANON_KEY)=")
SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  SUPABASE_ANON_KEY="$ANON_KEY" pnpm exec vitest run
```

Gotchas (all hit for real during this work):
- The local `.env` points at the HOSTED project; `scripts/test-or-skip.cjs`
  refuses non-local hosts (good — leave it). Override env vars instead, as
  above; process env beats `.env`.
- `ALTER DATABASE ... SET` must run as `supabase_admin` (the `postgres` user
  gets "permission denied to set parameter").
- The CI job (`pdm-security-tests` in `ci.yml`) does exactly these steps and
  calls `pnpm test:run` (raw vitest) so it can never silently skip.

### Deploying migrations to the hosted project

- **Never `supabase db push`** — the remote migration history is drifted
  (65+ repo files vs ~52 remote rows). Apply via the Management API / MCP
  `apply_migration`, then commit an identical mirror file in
  `supabase/migrations/`. Never edit an existing migration file.
- Validate first: `supabase db reset` locally applies everything from scratch
  — your new migration must survive that — then run the suite.
- Before any uniqueness constraint, check live data for violations (the
  top-level name index was verified against prod first: 0 duplicates).

## Invariants the fixes rely on (do not break these)

1. **The OS read-only bit is the vault-wide "clean copy" marker.** Writable =
   checked out by this user / possible unsaved edits. ANY code path that
   deletes or overwrites a local file must refuse when it's writable — the
   reaper, auto-sync held-back guard, bridge `/get-latest`, and checkout
   rollback all enforce this.
2. **RLS policies must resolve file→vault via the SECURITY DEFINER helpers**
   (`pdm.file_vault_id`, `pdm.version_vault_id`, `pdm.is_member_in`), never
   inline subqueries on `pdm.files` — a policy subquery runs under the
   caller's files RLS, where another user's draft is invisible, and wrongly
   denies the row. This exact footgun broke lock policies once already.
3. **Global role rows (`vault_id IS NULL`) are authoritative in every vault**
   — all helpers honor that; every current team member holds one.
4. **Storage is content-addressed and immutable** (`sha[0:2]/sha`); dedup
   probing must go through `pdm_object_exists`, not storage `list()`.
5. **`pdm.files.created_by` has `default auth.uid()`** — direct inserts used
   to create rows invisible to their own author (draft RLS); RPCs also set it
   explicitly.
6. `window.confirm` is a NO-OP in Tauri — use `ConfirmDialog`.

## Wave-3 backlog (ranked, all audit-confirmed, none started)

1. **Modern SolidWorks reference extraction** — `crates/pdm-sw-parser` reads
   refs from the legacy CFB container only; 2015+ files (the UnQLite/DEFLATE
   format the *properties* parser already handles) record **zero refs**.
   Prod `pdm.refs` is empty today partly because of this. Biggest remaining
   data-integrity gap; needs format research against real fixtures.
2. **Vault-wide Search screen** — a spec Phase-1 promise; only the spotlight
   name-picker exists. Filename + comment + extension over the active vault
   would close it.
3. **Slack notifications** — the outbox/dispatch pipeline
   (`20260603120000_notify_slack_dispatch.sql`) is fully built but the vault
   enqueue is wired to nothing. Decide which events (long-held locks,
   releases) before wiring; left dark deliberately.
4. **Recycle purge** — no way to permanently empty the Deleted tab. Needs
   content-GC care: only delete a storage object when NO other version
   (any vault) references its sha.
5. **`audit_log.vault_id`** — stamp at write time, then vault-scope reads
   (currently role-holder-gated, still cross-vault readable).
6. **macOS case-collision local paths** — two case-distinct vault files map
   to one local path on case-insensitive filesystems and silently overwrite;
   hold back the loser + banner (audit HIGH, deferred from wave 1).
7. **Auto-propagated deletes** (`useAutoSync`) — a checked-out file deleted
   locally becomes a vault soft-delete from one ledger observation; should
   require confirmation or stronger evidence.
8. Small: `useVaultAccess` uses `.maybeSingle()` on `user_roles` and errors
   for users holding global + per-vault rows; HistoryScreen "restore to
   working copy" wording vs the new Restore semantics; consider surfacing
   `dirty_local_copy` nicely in the SW add-in.

## Residual risks / unverified

- `addin_injector` changes are `cfg(windows)`; this machine is macOS, so they
  are parse-checked + unit-tested on the pure functions only. The next
  Windows release build is the real compile gate.
- Old (already-installed) clients still probe storage via `list()`: with the
  vault-scoped SELECT policy, their cross-vault duplicate-content check-in
  edge case fails until they update. Same-vault flows are unaffected.
- The migration-history drift on the hosted project remains (pre-existing);
  these waves followed the apply-via-API convention rather than repairing it.
- The root `conservation_*`/`physics_*` artifacts were intentionally left in
  place: they are live outputs of `crates/cfd-core/tests` harnesses that
  write to repo root by design. Tidying them means re-pointing those writers
  (a CFD-side change), not moving files.
