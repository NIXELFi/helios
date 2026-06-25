# Sub-project D — Security Review & Vetting Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Depends on Sub-project B's `plugin_versions.review_status` model + RPCs.**

**Goal:** No plugin version becomes installable by other members until it passes a vetting pipeline: an automated static scan (the same engine authors run), an optional monitored-sandbox dynamic pass, and a human approve/reject — with a reviewer queue in-app.

**Architecture:** A submitted version sits at `review_status='pending'`. Automated checks run the **single-sourced validator** against the uploaded bundle and attach a report; a reviewer with the `marketplace.review` capability sees the queue, the report, and the manifest diff, and approves/rejects. Approval flips the version to `approved` (the only state B will distribute) and updates `plugins.latest_version`. Tier-2 plugins (e.g. `engine:matlab`) require a human approval regardless of the automated result.

**Tech Stack:** the extracted shared validator (`@helios/plugin-sdk`), a Supabase RPC for the review transition, a reviewer UI in the Admin/Org area, and (Phase 2) a headless monitored-broker harness.

---

## Open decisions (resolve first)

1. **Where does the automated static scan run?** Options: (a) a Node CI job triggered on publish; (b) a desktop-side admin action a reviewer runs before approving; (c) a Supabase Edge Function. Recommend **(b) for v5.0.0** (reviewer clicks "Run checks", the desktop runs the shared validator on the downloaded bundle, writes the report) — no new infra. (Roadmap #4.)
2. **Is the monitored-sandbox dynamic pass in the first cut?** Recommend **Phase 2** (static + human first). (#4.)
3. **Reviewer role:** reuse `owner`/`exec`, or a dedicated `security-reviewer` role granted `marketplace.review`? Recommend a dedicated capability so it can be delegated.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/plugin-sdk/src/compliance.mjs` | **Canonical** forbidden-API + declared-vs-used + bundle-scan rules in **plain ESM** (the SDK has no build step, so the Node `.mjs` CLI must be able to `import` it directly — a `.ts` module cannot be imported by the `.mjs` CLI without a build). |
| `packages/plugin-sdk/src/compliance.d.ts` | Hand-written types so TS consumers (D's pipeline, vitest) import the same module typed. |
| `packages/plugin-sdk/cli/helios-plugin.mjs` (modify) | Thin wrapper: read files off disk → delegate to `compliance.mjs`. Closes the A-review L5 drift risk. |
| `packages/plugin-sdk/tests/compliance.test.ts` | Tests for the shared rules (good bundle passes, the known bad fixture fails). |
| `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_review.sql` | `review_plugin_version(plugin_id, version, decision, notes)` RPC + `reviewed_by`/`review_notes`/`review_report` columns; `marketplace.review` capability. |
| `apps/desktop/src/modules/org/marketplace-review/ReviewQueue.tsx` | Reviewer queue: pending versions, the report, manifest, approve/reject. |
| `apps/desktop/src/modules/org/marketplace-review/runChecks.ts` | Desktop action: download bundle → run `compliance` rules → produce a report. |
| `apps/desktop/src/modules/marketplace/runtime/MonitoredBroker.ts` (Phase 2) | Wraps `PluginBroker` recording every call/violation for the dynamic vetting pass. |

---

## Phase 1 — Single-sourced validator + review transition + reviewer UI

### Task D.1 — Extract the compliance rules into the SDK
**Files:** Create `packages/plugin-sdk/src/compliance.mjs` + `compliance.d.ts`, `tests/compliance.test.ts`; modify `cli/helios-plugin.mjs`, `src/index.ts`.
- [ ] **Step 1:** Write `compliance.test.ts`: `scanBundle({ "dist/index.html": "...fetch(..." }, manifest)` returns the forbidden-API + declared-vs-used findings; a clean bundle returns none. Cover the global-vs-member `fetch` distinction (A-review M6).
- [ ] **Step 2:** Run it (fails — module absent).
- [ ] **Step 3:** Implement `compliance.mjs` (plain ESM) exporting `FORBIDDEN`, `USAGE_TO_PERMISSION`, and `scanBundle(files, manifest): Finding[]` (the manifest checks can stay in TS `manifest.ts`; only the bundle-scan rules need to be in the `.mjs` the CLI shares). Add `compliance.d.ts` with the exported types; re-export from `index.ts`. **Rationale:** the CLI is plain Node ESM and cannot import a `.ts` source without a build step the SDK doesn't have — so the canonical rules live in `.mjs`, typed via the sidecar `.d.ts`.
- [ ] **Step 4:** Rewrite `helios-plugin.mjs` to read files off disk and delegate to `scanBundle` (no duplicated rules). Re-run the good/bad fixtures: good exit 0, bad exit 1.
- [ ] **Step 5:** `pnpm --filter @helios/plugin-sdk test` + typecheck green. Commit: `refactor(plugin-sdk): single-source compliance rules (CLI + pipeline share them)`.

### Task D.2 — Review RPC + columns
**Files:** Create `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_review.sql`; tests in `tests/rpc-marketplace-review.test.ts` (uses the `marketplace.*` test-reset added in B Task 2.2).
- [ ] **Step 1:** Add `reviewed_by uuid`, `review_notes text`, `review_report jsonb` to `marketplace.plugin_versions`. Add `review_plugin_version(plugin_id, version, decision text, notes text, report jsonb)` gated on `pm.has_capability('marketplace.review')`: sets `review_status`, `reviewed_by`, notes/report; on `approved`, updates `plugins.latest_version` if newer. Revoke direct `review_status` UPDATE so the RPC is the only path.
- [ ] **Step 2:** RLS tests: a non-reviewer cannot call it; a reviewer can; a `pending`→`approved` transition makes the version visible to `list_available_plugins`. Run `infra/pdm-supabase` suite.
- [ ] **Step 3:** Commit: `feat(marketplace): review transition RPC + audit columns`.

### Task D.3 — Reviewer queue UI + run-checks action
**Files:** Create `apps/desktop/src/modules/org/marketplace-review/{ReviewQueue.tsx,runChecks.ts}`; wire into the Admin module nav.
- [ ] **Step 1:** Test: the queue lists pending versions; "Run checks" populates a findings report from `runChecks` (which calls `scanBundle`); approve/reject calls `review_plugin_version`; a version with Tier-2 permissions shows a "human approval required" banner and cannot be auto-approved.
- [ ] **Step 2:** Implement `runChecks.ts` (download bundle via B's signed URL, unzip in-memory, `scanBundle`) and `ReviewQueue.tsx` (queue + report + manifest view + approve/reject with notes). Gate the whole panel on `useMyCapabilities().can("marketplace.review")`.
- [ ] **Step 3:** Tests green + typecheck. Commit: `feat(marketplace): reviewer queue with automated checks`.

---

## Phase 2 — Monitored-sandbox dynamic vetting (optional, post-v5.0.0)

### Task D.4 — `MonitoredBroker` + a headless vetting run
**Files:** Create `apps/desktop/src/modules/marketplace/runtime/MonitoredBroker.ts`.
- [ ] **Step 1:** Wrap `PluginBroker` so its existing `onCall` observations + any CSP violations are recorded into a transcript. (A's broker already emits `CallObservation`s — this is the hook the A spec §4 promised.)
- [ ] **Step 2:** A reviewer action mounts the candidate in a monitored `PluginHost`, exercises it, and asserts it never *attempts* a capability outside its manifest; attach the transcript to `review_report`.
- [ ] **Step 3:** Commit: `feat(marketplace): monitored-sandbox dynamic vetting pass`.

## Testing
The extracted `compliance` rules get unit tests (the security-relevant core). The review RPC gets RLS negative tests (non-reviewer denied; Tier-2 cannot bypass human approval). Treat approval as the gate that lets untrusted code reach other members — test it adversarially.

**Release gate:** add a `## [Unreleased]` "Security: plugin review/vetting pipeline" bullet to `CHANGELOG.md` (`scripts/check-versions.mjs` fails the release without it).

## Done when
A published version is invisible to members until a reviewer runs the automated checks and approves it; rejected versions never become installable; Tier-2 plugins always require a human decision.
