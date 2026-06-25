# Sub-project B — Marketplace Backend & Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Resolve the Open Decisions below with Nick before executing Phase 1+ (touches production Supabase).**

**Goal:** Let subteams publish versioned `.hplugin` bundles to a backend and let members install them, replacing Sub-project A's static local registry — and close the self-navigation egress gap with a production `plugin://` origin so untrusted plugins are safe to distribute.

**Architecture:** A new `marketplace` schema in the existing hosted Supabase project, content-addressed bundle storage in a Supabase Storage bucket, capability-gated publish + open install via RPCs with RLS, and a Tauri-side `plugin://<id>/` asset protocol + navigation handler that serves verified, locally-cached bundles at an isolated origin and refuses any navigation off it.

**Tech Stack:** Supabase (Postgres + RLS + Storage), PostgREST RPCs, Rust/Tauri custom URI scheme + navigation handler, the existing `infra/pdm-supabase/` migration + RLS test harness, TypeScript client hooks.

---

## Open decisions (resolve first)

1. **Who may publish?** Recommend a new `marketplace.publish` capability (subteam-scoped) in `pm.capabilities`, granted to Leads/Execs; owner publishes anywhere. (Roadmap decision #1.)
2. **Install model:** per-user install (recommended) vs per-subteam auto-enable. (#2.)
3. **Signing:** defer to v5.1 (recommended) vs sign bundles at publish. (#3.)
4. **Bundle size cap** + Storage quota per subteam. Recommend 25 MB/bundle to start.
5. **Migration home:** confirm `infra/pdm-supabase/migrations/` (single-project convention) vs a separate `marketplace` migration set.

---

## File structure

| File | Responsibility |
|---|---|
| `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_schema.sql` | `marketplace` schema: `plugins`, `plugin_versions`, `plugin_installs` tables. |
| `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_rls.sql` | RLS policies + `marketplace.publish`/`marketplace.review` capabilities seeded into `pm.capabilities`. |
| `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_rpcs.sql` | `publish_plugin_version`, `list_available_plugins`, `install_plugin`, `uninstall_plugin`, `get_bundle_download` RPCs. |
| `infra/pdm-supabase/tests/rls-marketplace.test.ts`, `rpc-marketplace.test.ts` | RLS/RPC integration tests (one-topic-per-file, matching the suite convention). |
| `apps/desktop/src-tauri/src/plugins/protocol.rs` | `plugin://<id>/<path>` asset protocol handler serving the local bundle cache. |
| `apps/desktop/src-tauri/src/plugins/cache.rs` | download + sha256-verify + unzip bundle into the app-data plugin cache; cache lookup. |
| `apps/desktop/src-tauri/src/lib.rs` (modify) | register the `plugin://` scheme, the nav handler (deny non-`plugin://`), and `install_plugin_bundle`/`remove_plugin_bundle` commands. |
| `apps/desktop/src/modules/marketplace/data/useMarketplace.ts` | client hooks: `useAvailablePlugins`, `useInstalledPlugins`, `useInstall`, `useUninstall`. |
| `apps/desktop/src/modules/marketplace/runtime/loader.ts` (modify) | load installed plugins from `plugin://<id>/` instead of `/plugins/...`; keep validate→mount path identical. |
| `apps/desktop/src/modules/marketplace/registry.ts` (delete) | static list replaced by the backend. |

---

## Phase 0 — `plugin://` origin + navigation hardening (spec §10 blocker)

This is the prerequisite that makes distributing untrusted plugins safe; it has no DB dependency, so do it first.

### Task 0.1 — Register a `plugin://` asset protocol serving the local cache
**Files:** Create `apps/desktop/src-tauri/src/plugins/protocol.rs`, `apps/desktop/src-tauri/src/plugins/cache.rs`; Modify `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 1:** In `cache.rs`, define the cache root (`app_data_dir()/plugins/<plugin_id>/<version>/`) and a `resolve(plugin_id, version, rel_path) -> Option<PathBuf>` that rejects any `rel_path` containing `..` or absolute components (defense-in-depth beyond the manifest `entry` guard).
- [ ] **Step 2:** In `protocol.rs`, register a custom protocol with `tauri::Builder::register_uri_scheme_protocol("plugin", ...)` that parses `plugin://<id>/<path>`, looks up the *currently-active version* for `<id>`, serves the file with the correct MIME, and 404s otherwise. (Cross-plugin isolation still comes from A's `sandbox="allow-scripts"` **opaque/null origin** — the iframe does NOT acquire a real `plugin://<id>` origin regardless of scheme; `plugin://` exists to serve cached files and to give the nav handler a scheme to allowlist. Do not rely on a per-plugin real origin.)
- [ ] **Step 3 (CRITICAL — the network wall):** When serving the ENTRY document, attach the CSP as a **response header** — the exact policy string from A's `PluginHost.withCsp` (`default-src 'none'; connect-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; child-src blob:; form-action 'none'; base-uri 'none'`). **Mandatory:** switching the host from `srcDoc` to `src="plugin://…"` (Task 0.2) bypasses `withCsp()`, so without this header the production document has NO CSP and `connect-src 'none'` is lost for exactly the untrusted plugins this phase protects. NEVER trust the bundle's own `index.html` for the policy. **Acceptance test:** a plugin served over `plugin://` cannot `fetch()` (blocked by the header CSP).
- [ ] **Step 4:** Run `cargo build -p helios-desktop` (or `pnpm --filter @helios/desktop tauri build` smoke) to confirm it compiles.
- [ ] **Step 5:** Commit: `feat(marketplace): plugin:// asset protocol + CSP response header`.

### Task 0.2 — Navigation handler: deny any navigation off `plugin://`
**Files:** Modify `apps/desktop/src-tauri/src/lib.rs` (and `tauri.conf.json` CSP if needed).

- [ ] **Step 1:** On the plugin webview/frame, attach `on_navigation(|url| url.scheme() == "plugin")` (Tauri `WebviewWindowBuilder::on_navigation` / `on_page_load`) so a plugin calling `location.assign("https://…")` is **refused** — closing the H1 self-navigation exfiltration channel from spec §10.
- [ ] **Step 2 (HARD GATE — this is the §10 blocker itself):** Phase 0 is NOT done until a plugin attempting `location.assign("https://example.com")` is provably **refused** and the frame stays put. Verify this concretely (a checked-in manual repro at minimum). ⚠️ Tauri's `on_navigation` is attached per-webview at builder time, but plugins are an `<iframe>` sub-frame inside the main webview (created from `tauri.conf.json`, not a `WebviewWindowBuilder` in `lib.rs`) — so confirm `on_navigation` actually fires for iframe *sub-frame* self-navigation. If it does NOT, fall back to the per-plugin locked-down Tauri webview (A spec "Approach 3") for the production path; the isolation guarantee MUST hold before any untrusted plugin is installable.
- [ ] **Step 3:** Update the host so `PluginHost` mounts installed plugins via `src={plugin://<id>/<entry>}` (production path) while still supporting `srcDoc` for the bundled dev example. Keep the `sandbox="allow-scripts"` (no `allow-same-origin`) + CSP exactly as in A.
- [ ] **Step 4:** Commit: `feat(marketplace): deny off-origin navigation from plugin frames (closes self-nav egress)`.

> **NOTE for the implementer:** if Tauri's per-frame navigation control proves insufficient for an `<iframe>` (vs a full webview window), fall back to rendering each plugin in its own locked-down Tauri webview as in the A spec's "Approach 3" — but only for the production path; the isolation guarantee must hold. Capture the decision in the spec.

---

## Phase 1 — Schema

### Task 1.0 — Expose the `marketplace` schema to PostgREST (prerequisite for ALL RPC/RLS work)
**Files:** Modify `infra/pdm-supabase/supabase/config.toml`.
- [ ] **Step 1:** Append `marketplace` to both the `[api] schemas = [...]` and `extra_search_path = [...]` arrays (currently `["public", "graphql_public", "pdm", "pm"]`). Without this, every `client.schema("marketplace")` call and every RLS/RPC test fails with "schema must be one of…".
- [ ] **Step 2:** Note in the rollout section: the **prod** project's Exposed Schemas must be set separately in the dashboard/API settings — `supabase db push` does NOT carry this.
- [ ] **Step 3:** Commit: `chore(marketplace): expose marketplace schema to PostgREST`.

### Task 1.1 — `marketplace` schema + tables
**Files:** Create `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_schema.sql`.

- [ ] **Step 1:** Write the migration (review before applying to prod):

```sql
create schema if not exists marketplace;

create table marketplace.plugins (
  id            text primary key,              -- the manifest id, e.g. 'aero.downforce-calculator'
  name          text not null,
  subteam       text,                          -- owning subteam (maps to pm subteams)
  created_by    uuid not null references auth.users(id),
  latest_version text,                          -- newest APPROVED version (denormalized for listing)
  created_at    timestamptz not null default now()
);

create table marketplace.plugin_versions (
  plugin_id     text not null references marketplace.plugins(id) on delete cascade,
  version       text not null,                 -- plugin semver
  manifest      jsonb not null,                -- the full validated manifest
  permissions   text[] not null default '{}',  -- denormalized declared permissions
  bundle_sha256 text not null,                 -- content-addressed key into the storage bucket
  bundle_bytes  bigint not null,
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  published_by  uuid not null references auth.users(id),
  published_at  timestamptz not null default now(),
  primary key (plugin_id, version)
);

create table marketplace.plugin_installs (
  user_id          uuid not null references auth.users(id),
  plugin_id        text not null references marketplace.plugins(id) on delete cascade,
  installed_version text not null,
  installed_at     timestamptz not null default now(),
  primary key (user_id, plugin_id)
);
```

- [ ] **Step 2:** Apply to a local Supabase stack (`cd infra/pdm-supabase; supabase start`) and confirm it migrates clean. Do **not** apply to prod yet.
- [ ] **Step 3:** Commit: `feat(marketplace): schema for plugins, versions, installs`.

---

## Phase 2 — RLS + capabilities

### Task 2.1 — Seed publish/review capabilities
**Files:** Create `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_rls.sql`.

- [ ] **Step 1:** Insert `marketplace.publish` (subteam-scoped) and `marketplace.review` (org-scoped) into `pm.capabilities`, and grant them to the appropriate seeded roles (Lead/Exec, plus a `security-reviewer`), consistent with [[unified-org-roles-initiative]]. Confirm the exact role grants with Nick (open decision #1).

### Task 2.2 — RLS policies
- [ ] **Step 2:** Enable RLS on all three tables. Policies:
  - `plugins`/`plugin_versions` **SELECT**: any authenticated user may read plugins whose owning subteam is theirs OR that have an `approved` version (org-wide discoverability) — final visibility rule TBD with Nick.
  - `plugin_versions` **INSERT**: only via the `publish_plugin_version` RPC (revoke direct writes); enforce `pm.has_capability(auth.uid(), 'marketplace.publish', subteam_id)` (real signature: `pm.has_capability(uid uuid, cap text, stid uuid default null)` — pass `auth.uid()` first).
  - `review_status` **UPDATE**: only via the review RPC (D), gated on `marketplace.review`.
  - `plugin_installs`: a user may only read/write their own rows.
- [ ] **Step 3:** Extend the test fixture so marketplace rows don't leak between tests: the suite's `beforeEach` calls `pdm.test_reset()` (in `…/supabase/migrations/20260508000100_pdm_test_reset.sql`), which truncates `pdm.*`/`auth.users` only. Add `marketplace.*` truncation to it (or a `marketplace.test_reset()`), guarded by the same `app.environment='test'` check.
- [ ] **Step 4:** Write the RLS test cases in `infra/pdm-supabase/tests/rls-marketplace.test.ts` (one-topic-per-file, matching the suite's convention; impersonate a non-member, a member, a lead, a reviewer; assert each policy). Run `cd infra/pdm-supabase; pnpm test`.
- [ ] **Step 5:** Commit: `feat(marketplace): RLS + publish/review capabilities`.

---

## Phase 3 — Bundle storage + RPCs

### Task 3.1 — Storage bucket (content-addressed)
- [ ] **Step 1:** Create a private Storage bucket `plugins`; objects keyed by `bundle_sha256`. Storage RLS: write only via service-side publish path; read via short-lived signed URLs from `get_bundle_download`.

### Task 3.2 — RPCs (TDD against the local stack)
**Files:** Create `infra/pdm-supabase/supabase/migrations/20260626XXXXXX_marketplace_rpcs.sql`; tests in `tests/rpc-marketplace.test.ts`.

- [ ] **Step 1:** Write failing tests for each RPC, then implement:
  - `publish_plugin_version(manifest jsonb, bundle_sha256 text, bytes bigint)`: re-validates the manifest **server-side** (mirror `validateManifest` rules — see the shared validator from D/Roadmap), enforces `marketplace.publish` for the manifest's subteam, upserts `plugins`, inserts a `plugin_versions` row with `review_status='pending'`. Returns the new version row.
  - `list_available_plugins()`: returns plugins + their newest `approved` version the caller may see, with an `installed_version` join for the caller.
  - `install_plugin(plugin_id text, version text)` / `uninstall_plugin(plugin_id text)`: writes/removes the caller's `plugin_installs` row; refuses unapproved versions.
  - `get_bundle_download(plugin_id text, version text)`: returns a signed URL for an approved, installable version only.
- [ ] **Step 2:** Run `pnpm test` in `infra/pdm-supabase` — all green.
- [ ] **Step 3:** Commit: `feat(marketplace): publish/list/install RPCs + bundle storage`.

---

## Phase 4 — Local install cache + loader integration

### Task 4.1 — Download, verify, unzip on install
**Files:** Modify `apps/desktop/src-tauri/src/plugins/cache.rs`, `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 1:** Add a Tauri command `install_plugin_bundle(plugin_id, version, signed_url)` that downloads the zip, **verifies sha256 against the manifest record** (reject on mismatch), unzips into the cache dir, and re-runs `validateManifest` on the unpacked manifest before marking it ready. Add `remove_plugin_bundle(plugin_id)`.
- [ ] **Step 2:** Unit-test the sha256 verification + the `..`-rejecting unzip path (a zip-slip test) in Rust.
- [ ] **Step 3:** Commit: `feat(marketplace): verified local install cache`.

### Task 4.2 — Point the loader at installed plugins
**Files:** Modify `apps/desktop/src/modules/marketplace/runtime/loader.ts`; delete `registry.ts`.

- [ ] **Step 1:** `loadPlugin` resolves an installed plugin's base to `plugin://<id>/` and fetches `manifest.json` + entry from there; the validate→mount→broker path is otherwise unchanged from A.
- [ ] **Step 2:** Keep a dev-only fallback to the bundled `/plugins/spring-rate` example so the demo still works without a backend.
- [ ] **Step 3:** `pnpm --filter @helios/desktop typecheck` + existing marketplace tests green. Commit.

---

## Phase 5 — Client data hooks

### Task 5.1 — `useMarketplace.ts`
**Files:** Create `apps/desktop/src/modules/marketplace/data/useMarketplace.ts`; tests under `__tests__/`.

- [ ] **Step 1:** Hooks calling the RPCs via `client.schema("marketplace").rpc(...)`: `useAvailablePlugins`, `useInstalledPlugins`, `useInstall` (calls RPC → `install_plugin_bundle` Tauri command), `useUninstall`. Mirror the data-hook patterns in `modules/org/data/useOrgData.ts`.
- [ ] **Step 2:** Component/hook tests with a mocked client. `pnpm --filter @helios/desktop test`. Commit.

---

## Testing & rollout

- **DB:** the `infra/pdm-supabase` RLS/RPC suite is the gate (runs in CI against a real local stack). Apply to prod via `supabase link` + `supabase db push` (the convention in `infra/pdm-supabase/README.md`), or the Management API `/database/query` endpoint if the DB is unreachable locally ([[helios-v446-polish]] gotchas). **Either way, separately set the prod project's Exposed Schemas to include `marketplace`** — `db push` does not carry that API setting (see Task 1.0). Apply only after the suite is green and Nick approves the schema.
- **Rust:** `cargo test` for cache/protocol; zip-slip + sha256 mismatch must be covered.
- **Release gate:** add a `## [Unreleased]` bullet to `CHANGELOG.md` (Added: marketplace publish/install; Security: `plugin://` + CSP header + off-origin nav block) — `scripts/check-versions.mjs` fails the release without it.
- **Risk:** RLS mistakes here are prod-security issues (cf. the v4 audit C-1/C-3 class in [[helios-v4-bug-vault]]) — review every policy adversarially and test the negative cases.

## Done when
A Lead can publish a version (lands `pending`), and once approved (D) a member can install it (verified, cached, served from `plugin://`), launch it, and a plugin can no longer navigate itself off-origin.
