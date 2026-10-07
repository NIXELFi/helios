# September 8 Audit Fixes Implementation Plan

> **For agentic workers:** Use test-driven development with bounded implementation and review. Nick prefers lean execution and no nested agents.

**Goal:** Fix the five reproduced audit defects, publish a reviewable fix branch, and preserve other unpublished local branches on GitHub.

**Architecture:** Keep existing PM store and module boundaries. Guard every asynchronous hydration by its owning session and write epoch, and make task-edit rollback operation-specific. Preserve missing sensor values through decoding and aggregation. Propagate one-shot compactor failures to its exit status.

**Tech stack:** React, Zustand, Vitest, TypeScript/Deno ingest, Rust/Arrow/Parquet, GitHub CLI.

## PM refresh lifecycle and startup revalidation

Files: `apps/desktop/src/modules/pm/PmModule.tsx`, new `apps/desktop/src/modules/pm/__tests__/PmModule.refresh.test.tsx`.

- [ ] Add failing production-component tests for refresh-after-unmount/account change, explicit reload after cleanup, cached startup edit during fetch, and a write that starts and finishes during fetch.
- [ ] Invalidate every asynchronous effect/reload on cleanup; never rehydrate a previous session's store.
- [ ] Guard initial and background hydration with write epochs; retry when writes drain, including writes that already drained before a stale fetch returned. Preserve active project and error state appropriately.
- [ ] Run targeted Vitest tests, then desktop suite and typechecks.

## PM task rollback isolation

Files: `apps/desktop/src/modules/pm/lib/pmStore.ts`, `apps/desktop/src/modules/pm/lib/__tests__/pmStore.persist.test.tsx`.

- [ ] Add failing tests with independently deferred writes: edit A fails after B succeeds; overlapping edits to one task must retain the newer value; exercise bulk edits too.
- [ ] Replace whole-task-array rollback for update/bulk update with operation-specific before/after patches. Restore only fields still holding this operation's optimistic value; preserve newer changes and unrelated activity. Keep failed edits from becoming undoable commands.
- [ ] Run the persistence suite including existing undo/redo and partial-write recovery cases.

## Telemetry missing values and compactor exit

Files: `infra/telemetry-supabase/supabase/functions/telemetry-ingest/frame.ts` and decoder tests; `crates/helios-compactor/src/compact.rs`, `src/main.rs`, and regression tests. Add decoder coverage to an existing local/CI test runner if Deno is unavailable.

- [ ] Add a failing decoder test with the real Rust golden frame containing an i16fp null sentinel; retain valid extreme negative readings.
- [ ] Decode the sentinel to NaN/missing and make 1 Hz aggregation ignore missing samples per channel, retaining missing output for all-missing buckets. Cover Arrow nulls and NaNs with Rust tests.
- [ ] Add an executable CLI regression against a loopback HTTP mock returning 500; --once must exit nonzero. Also cover a successful empty scan.
- [ ] Apply minimal fixes and run decoder, compactor, and HTP suites offline where possible.

## Documentation, review, and publication

- [ ] Add five `v2_changes/63-*.md` through `67-*.md` notes and update the index; add user-facing entries to CHANGELOG.md.
- [ ] Review the complete diff for requirement coverage and code quality; resolve material findings.
- [ ] Run workspace typechecks, desktop and affected Rust tests, and required pre-commit parity checks. No production database changes or release tags.
- [ ] Commit and push `fix/audit-0908`; create a PR based on `feat/telemetry-live-path` to keep already-existing telemetry work outside the fix diff.
- [ ] Compare all local branches to freshly fetched origin refs. Push missing/ahead branches without force, merging, deleting refs, or committing unrelated dirty worktrees. Verify published commit IDs and report any divergence or uncommitted work separately.
