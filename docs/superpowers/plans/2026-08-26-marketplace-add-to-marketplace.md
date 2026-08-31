# Add to Marketplace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any subteam engineer publish and maintain a Helios plugin from inside the app — pick a folder, pass a pre-flight, submit, get reviewed — replacing the hand-rolled Management API runbook that one person knows.

**Architecture:** A pure Rust packer (`crates/plugin-host/src/pack.rs`) turns a folder into a deterministic, forward-slash-entried `.hplugin` plus its sha256 and the text of every scannable file. The frontend runs the *same* `compliance.mjs` scan the review pipeline runs, uploads the bundle content-addressed to the existing `plugins` bucket, and calls the existing `publish_plugin_version`. A new Review tab re-scans the stored bytes (never trusting the author's report) and can test-drive a pending build before deciding. One migration adds `withdrawn`/`yanked` states, preview installs, and the author-side management RPCs.

**Tech Stack:** Rust (`zip` 2, `sha2`, `reqwest`) · Tauri v2 commands + `@tauri-apps/plugin-dialog` / `plugin-fs` · React 18 + TypeScript + Tailwind · Supabase Postgres RPCs + Storage · vitest · cargo test

**Spec:** `docs/superpowers/specs/2026-08-26-marketplace-add-to-marketplace-design.md`

---

## STATUS — 2026-08-26

**PHASE 1 IS COMPLETE AND COMMITTED** on `feat/marketplace-add-to-marketplace`
(branched from `main` @ `ff1b19be`). **Not pushed, no PR, not applied to prod.**

| Commit | What |
|---|---|
| `71c0840f` | spec |
| `ef4eb36c` | plan + migration `20260826010000` + 16 structural tests + CI-only RLS tests |
| `14826ef5` | `plugin-host::pack` + the two Tauri commands |
| `6866a765` | pre-flight / permission diff / publish errors / state machine (49 tests) |
| `71b60938` | submit wizard + Review tab + help drawer + screenshot harness |

Verified at the Phase 1 gate: `cargo test -p plugin-host` 35 green ·
`cargo check` clean in `src-tauri` · desktop typecheck clean · marketplace suite
127 green · full desktop suite **2357 green** · all four screens screenshotted and
reviewed · no horizontal overflow at 1024/1280/1600.

One caveat on the full-suite run: it reports `2357 passed | 1 error`. The stderr
in that run is all pre-existing noise from **other** modules (a games
`saveLedger` test whose `@tauri-apps/plugin-fs` mock lacks `mkdir`, and vault
"no tauri in test" lines). Nothing marketplace-related, and the marketplace suite
is clean on its own — but **confirm it is pre-existing** by running the suite on
`main` before blaming anything here.

### Next session starts here

1. **Phase 2** (Task 10–11): My Plugins. All four RPCs it needs already exist in
   the migration and are structurally tested — only the hook and the view are
   left.
2. **Phase 3** (Task 12–14): scaffold + agent prompt + wiring the help drawer's
   "Start a new plugin" entry point.
3. Then: push, PR, and apply the migration to prod **via the Management API with
   an `sbp_` token** — never `supabase db push` (stamp drift: ~100 local versions
   read as pending against 64 recorded). Record the version manually afterwards.
4. Nick has not yet seen any of this in the real app. The screenshots were taken
   against `uiharness/`, which stubs the IO — a live `pnpm dev` smoke test with a
   real folder is still owed, and is the only thing that exercises
   `pack_plugin_bundle` against a genuine plugin project on disk.

### Gotchas banked while building Phase 1

- **`signInAs(email)` takes an email string, not the user object** from
  `createTestUser`. Costs a typecheck failure in every new RLS test otherwise.
- **`infra/pdm-supabase` tests all hard-require DB credentials** — `tests/setup.ts`
  throws without them, so the whole vitest run dies. DB-less structural tests
  therefore live under `vitest.structure.config.ts` (no `setupFiles`), wired into
  the package's `test` script so they always run. Use that pattern for any future
  migration-shape test.
- **`npx vitest` resolves a DIFFERENT vitest** from the npx cache and dies on a
  missing `jsdom`. Always run through the workspace: `pnpm --filter @helios/desktop test`.
- **A Tauri command's return struct keeps its Rust field names** across IPC unless
  you add `#[serde(rename_all = "camelCase")]`. Only the *arguments* are converted
  automatically. Both new command structs carry the attribute.
- **jsdom has no `Element.scrollTo`**, so `ref.current?.scrollTo({...})` throws
  inside an effect. `?.scrollTo?.()` — the guard belongs in the component.
- **`MarketplaceModule` now reads org capabilities**, so any test rendering it must
  mock `../../org/data/useOrgData` or it throws
  "useAuth* hooks must be used inside <SupabaseAuthProvider>".
- **The harness renders black-on-black** unless Tailwind's `content` globs are made
  absolute — with Vite's root at `uiharness/`, the app config's relative globs match
  nothing and every utility class is purged. That is what
  `uiharness/tailwind.config.ts` exists to fix.

---

## Ground rules for this plan

- **Do NOT `--no-verify`.** A pre-commit hook runs the full Rust parity suite (~5–10 min) on every commit. Let it run.
- **Every phase adds a CHANGELOG `[Unreleased]` bullet.** `scripts/check-versions.mjs` fails the release without one.
- **Desktop crate tests cannot run on this machine** (WebView2 `0xc0000139`). Put every testable Rust behavior in `crates/plugin-host`, which has no Tauri dependency and runs locally.
- **Live SQL/RLS tests need a database this machine does not have** (no Docker → no local Supabase). Write them anyway for CI, and add a DB-less structural test that parses the migration file so something verifies locally.
- **Verify UI by screenshot before calling it done** (standing rule).
- Commands: `pnpm --filter @helios/desktop test`, `pnpm --filter @helios/desktop typecheck`, `cargo test -p plugin-host`.

## File structure

| File | Responsibility |
|---|---|
| `infra/pdm-supabase/supabase/migrations/20260826010000_marketplace_publish_ui.sql` | New states, `is_preview`, author + preview RPCs |
| `infra/pdm-supabase/tests/marketplace-publish-ui.structure.test.ts` | DB-less: asserts the migration's shape |
| `infra/pdm-supabase/tests/rls-marketplace-publish.test.ts` | Live-DB ACL tests (CI) |
| `crates/plugin-host/src/pack.rs` | Pure: dir → zip + sha256 + texts; zip → texts |
| `apps/desktop/src-tauri/src/plugins/commands.rs` | +`pack_plugin_bundle`, +`inspect_plugin_bundle` |
| `.../marketplace/publish/preflight.ts` | Pure: findings → grouped + explained |
| `.../marketplace/publish/permissionDiff.ts` | Pure: previous vs next permissions |
| `.../marketplace/publish/publishErrors.ts` | Pure: raw error → human sentence |
| `.../marketplace/publish/usePublish.ts` | pack → preflight → upload → RPC state machine |
| `.../marketplace/publish/SubmitWizard.tsx` + `steps/*.tsx` | Step chrome and views only |
| `.../marketplace/review/ReviewView.tsx` | Queue, diff, re-scan, decide |
| `.../marketplace/data/useReview.ts` | +inspect, +preview install |
| `.../marketplace/data/installBundle.ts` | Extracted shared download→verify→unpack |
| `.../marketplace/manage/useMyPlugins.ts` + `MyPluginsView.tsx` | Phase 2 |
| `.../marketplace/authoring/*` | Phase 3 kit, scaffold, prompt, help |
| `.../marketplace/MarketplaceModule.tsx` | Tab + header wiring only |

---

# PHASE 1 — the loop closes

*End state: an engineer publishes from the app, a lead approves from the app, a member installs. Nothing before this point is usable on its own.*

### Task 1: Migration — new states, preview installs, author RPCs

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260826010000_marketplace_publish_ui.sql`
- Create: `infra/pdm-supabase/tests/marketplace-publish-ui.structure.test.ts`

> `20260826000000` is already taken by `fix_plinko_drop_search_path.sql`. Use `010000`.

- [ ] **Step 1: Write the failing structural test**

```ts
// infra/pdm-supabase/tests/marketplace-publish-ui.structure.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../supabase/migrations/20260826010000_marketplace_publish_ui.sql"),
  "utf8",
);

describe("marketplace publish-UI migration", () => {
  it("widens review_status to include withdrawn and yanked", () => {
    expect(SQL).toMatch(/review_status in \('pending','approved','rejected','withdrawn','yanked'\)/);
  });

  it("adds an is_preview flag to plugin_installs", () => {
    expect(SQL).toMatch(/add column if not exists is_preview boolean not null default false/);
  });

  it.each([
    "my_published_plugins",
    "withdraw_plugin_version",
    "yank_plugin_version",
    "set_plugin_recommended",
    "install_plugin_for_review",
  ])("defines %s", (fn) => {
    expect(SQL).toMatch(new RegExp(`create or replace function marketplace\\.${fn}`));
  });

  it("pins search_path on every new function (no mutable search_path)", () => {
    const defs = SQL.split(/create or replace function/).slice(1);
    for (const d of defs) expect(d).toMatch(/set search_path =/);
  });

  it("re-checks capabilities server-side in every mutating RPC", () => {
    for (const fn of ["withdraw_plugin_version", "yank_plugin_version", "set_plugin_recommended"]) {
      const body = SQL.split(`function marketplace.${fn}`)[1].split("grant execute")[0];
      expect(body).toMatch(/pm\.has_capability\(v_uid, 'marketplace\.publish'/);
    }
    const review = SQL.split("function marketplace.install_plugin_for_review")[1].split("grant execute")[0];
    expect(review).toMatch(/pm\.has_capability\(v_uid, 'marketplace\.review'/);
  });

  it("keeps preview installs out of the Browse installed_version", () => {
    const listing = SQL.split("function marketplace.list_available_plugins")[1];
    expect(listing).toMatch(/inst\.is_preview\s*=\s*false/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd infra/pdm-supabase && npx vitest run tests/marketplace-publish-ui.structure.test.ts`
Expected: FAIL — `ENOENT` (the migration does not exist yet).

- [ ] **Step 3: Write the migration**

Contents, in order:

1. **Widen the status check.** Drop and recreate the constraint:
   `alter table marketplace.plugin_versions drop constraint if exists plugin_versions_review_status_check;`
   then add it back with the five states. (Find the real constraint name first with a `\d`-equivalent query, or use `do $$` to look it up in `pg_constraint` — a hardcoded name that does not match silently leaves the old constraint in place, which is the failure mode to avoid.)
2. **`alter table marketplace.plugin_installs add column if not exists is_preview boolean not null default false;`**
3. **Recreate `list_available_plugins`** exactly as it is today, with the install join gaining `and inst.is_preview = false`. Copy the existing body from `20260626000300_marketplace_rpcs.sql:146` — do not improvise it.
4. **`my_published_plugins()`** — `language sql stable`, SECURITY INVOKER, returns one row per version:
   `plugin_id, name, subteam, is_recommended, latest_version, version, manifest, permissions, review_status, review_notes, reviewed_at, published_by, published_at, bundle_bytes` for every plugin where `pm.has_capability(auth.uid(),'marketplace.publish', p.subteam)`, ordered by `p.name`, `pv.published_at desc`.
5. **`withdraw_plugin_version(p_plugin_id text, p_version text)`** — SECURITY DEFINER, `set search_path = marketplace, pm, public`. Requires `marketplace.publish` on the owning subteam; requires current status `pending` (else raise naming the actual status); sets `withdrawn`. No `latest_version` recompute needed — a pending row was never the latest.
6. **`yank_plugin_version(p_plugin_id text, p_version text, p_reason text default null)`** — same gating; requires current status `approved`; sets `yanked`, appends the reason to `review_notes`; then recomputes `plugins.latest_version` with the **exact** query `review_plugin_version` uses (newest `approved` by `published_at desc`), so the two can never disagree.
7. **`set_plugin_recommended(p_plugin_id text, p_value boolean)`** — same gating; updates `plugins.is_recommended` and `updated_at`.
8. **`install_plugin_for_review(p_plugin_id text, p_version text)`** — a copy of `install_plugin` with three changes: it requires `pm.has_capability(v_uid,'marketplace.review', marketplace.plugin_subteam(p_plugin_id))`, it accepts **only** `review_status = 'pending'` (raise otherwise), and it inserts with `is_preview = true` (`on conflict … do update set installed_version = excluded.installed_version, installed_at = now(), is_preview = true`). Keep `#variable_conflict use_column` — the OUT columns shadow table columns exactly as they do in the original.
9. `grant execute … to authenticated` for all five.

- [ ] **Step 4: Run the structural test to green**

Run: `cd infra/pdm-supabase && npx vitest run tests/marketplace-publish-ui.structure.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the live-DB ACL tests (CI-only, will not run here)**

Create `infra/pdm-supabase/tests/rls-marketplace-publish.test.ts` following the `rls-dashboard-layouts.test.ts` pattern. Cases:
- a publisher on subteam A cannot withdraw/yank/recommend a plugin owned by subteam B;
- `withdraw` on an approved version raises; `yank` on a pending version raises;
- a yanked version vanishes from `list_available_plugins` and `install_plugin` refuses it;
- `install_plugin_for_review` refuses a non-reviewer, refuses an already-approved version, and marks the row `is_preview = true`;
- a preview install does not populate `installed_version` in `list_available_plugins`.

- [ ] **Step 6: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260826010000_marketplace_publish_ui.sql \
        infra/pdm-supabase/tests/marketplace-publish-ui.structure.test.ts \
        infra/pdm-supabase/tests/rls-marketplace-publish.test.ts
git commit -m "feat(marketplace): withdraw/yank states, preview installs, author RPCs"
```

> **Do not apply to prod yet.** When it is time: Management API + an `sbp_` token, never `supabase db push` (100 local versions read as pending against 64 recorded — stamp drift), then record the version manually.

---

### Task 2: `pack.rs` — the pure packer

**Files:**
- Create: `crates/plugin-host/src/pack.rs`
- Modify: `crates/plugin-host/src/lib.rs` (add `pub mod pack;`)
- Modify: `crates/plugin-host/Cargo.toml` (dev-dep `tempfile`)

- [ ] **Step 1: Write the failing tests**

In `pack.rs`, a `#[cfg(test)] mod tests` covering:

```rust
#[test] fn packs_manifest_and_entry_dir_only() { /* src/, node_modules/ excluded */ }
#[test] fn every_entry_uses_forward_slashes() { /* nested dir on Windows paths */ }
#[test] fn is_deterministic() { /* pack twice -> identical sha256 */ }
#[test] fn refuses_missing_manifest() { }
#[test] fn refuses_entry_not_in_bundle() { /* manifest.entry = dist/index.html, no dist/ */ }
#[test] fn refuses_symlinks() { /* skip on windows without privilege: cfg(unix) */ }
#[test] fn enforces_the_size_ceiling() { /* > 25 MiB -> Err naming the largest file */ }
#[test] fn collects_scannable_texts_only() { /* .js/.mjs/.html/.css in, .png out */ }
#[test] fn round_trips_through_unpack_zip() { /* pack -> unpack_zip -> same files on disk */ }
#[test] fn read_zip_texts_returns_manifest_and_sources() { }
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p plugin-host pack`
Expected: FAIL — `pack.rs` does not exist / `unresolved module`.

- [ ] **Step 3: Implement**

```rust
pub struct PackedBundle {
    pub zip: Vec<u8>,
    pub sha256: String,
    pub entries: Vec<String>,
    pub texts: BTreeMap<String, String>,
    pub manifest_json: String,
    pub warnings: Vec<String>,
    pub largest: Vec<(String, u64)>,
}

pub fn pack_dir(root: &Path) -> Result<PackedBundle, String>;
pub fn read_zip_texts(bytes: &[u8]) -> Result<(String, BTreeMap<String, String>), String>;
```

Rules, all enforced here rather than in the UI:
- `manifest.json` must exist at `root`; parse it as `serde_json::Value` for `entry` and `icon`.
- Include `manifest.json`, everything under the first path segment of `entry` (normally `dist/`), and `icon` if it lives elsewhere. Error if the exact `entry` file is absent.
- Exclude any path containing a `node_modules`, `.git`, or `src` segment, and the names `.DS_Store` / `Thumbs.db` / `*.map`.
- `symlink_metadata(...).file_type().is_symlink()` → error naming the path.
- Reject any relative path that escapes `root` after normalization (reuse `path::resolve`'s posture).
- Sort entries; write with `SimpleFileOptions::default().compression_method(Deflated).last_modified_time(zip::DateTime::default())` so the sha256 is a function of content alone.
- Build entry names by joining components with `'/'` — never `Path::display()`, which yields backslashes on Windows. This is the whole point of the task.
- Abort past 200 MiB of input before compressing; error if the finished zip exceeds `MAX_BUNDLE_BYTES` (25 MiB), listing `largest`.
- `texts`: extensions `.js .mjs .html .css .json .md`, valid UTF-8, under 2 MiB each.

- [ ] **Step 4: Run to green**

Run: `cargo test -p plugin-host`
Expected: PASS — the existing 21 tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add crates/plugin-host/src/pack.rs crates/plugin-host/src/lib.rs crates/plugin-host/Cargo.toml
git commit -m "feat(plugin-host): deterministic folder packer with forward-slash zip entries"
```

---

### Task 3: The two Tauri commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/plugins/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register in `invoke_handler`)

Bytes never cross the IPC boundary. `pack_plugin_bundle` writes the zip to
`<appCacheDir>/plugin-staging/<sha256>.hplugin` and returns the path; the frontend
reads it with `@tauri-apps/plugin-fs` (scope is already `**`) when it uploads. That
also delivers the spec's promise that Retry does not re-zip.

- [ ] **Step 1: Add `pack_plugin_bundle`**

```rust
#[derive(serde::Serialize)]
pub struct PackedBundleInfo {
    pub staged_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub manifest: serde_json::Value,
    pub entries: Vec<String>,
    pub texts: std::collections::BTreeMap<String, String>,
    pub warnings: Vec<String>,
    pub largest: Vec<(String, u64)>,
}

#[tauri::command]
pub fn pack_plugin_bundle(app: AppHandle, dir: String) -> Result<PackedBundleInfo, String>
```

Validates that `dir` exists and is a directory, calls `plugin_host::pack::pack_dir`, writes the staged file, returns the info.

- [ ] **Step 2: Add `inspect_plugin_bundle`**

```rust
#[tauri::command]
pub async fn inspect_plugin_bundle(
    signed_url: String,
    expected_sha256: String,
    bundle_bytes: u64,
) -> Result<InspectedBundle, String>
```

Reuses the streaming, ceiling-aborting download already in `install_plugin_bundle`
(extract it to a private `download_capped(url, max) -> Vec<u8>` and call it from
both — do not copy it), verifies the sha256, then `read_zip_texts`. Returns
`{ manifest, texts }`. It writes nothing to disk.

- [ ] **Step 3: Add a staging sweeper**

`pub fn sweep_plugin_staging(app: &AppHandle)` — deletes staged `.hplugin` files
older than 7 days. Call it where the app already does startup housekeeping.

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: clean. (Desktop tests still cannot run here — that is why the logic lives in `plugin-host`.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat(marketplace): pack and inspect plugin bundle commands"
```

---

### Task 4: `preflight.ts` — findings a non-coder can act on

**Files:**
- Create: `apps/desktop/src/modules/marketplace/publish/preflight.ts`
- Create: `apps/desktop/src/modules/marketplace/publish/__tests__/preflight.test.ts`
- Possibly modify: `packages/plugin-sdk/package.json` / `src/index.ts` to export `scanBundle`

- [ ] **Step 1: Confirm the scanner is importable**

Run: `node -e "import('./packages/plugin-sdk/src/compliance.mjs').then(m=>console.log(Object.keys(m)))"`
Expected: `ALLOWED_PERMISSIONS, FORBIDDEN, USAGE_TO_PERMISSION, SCANNABLE_EXTENSIONS, scanBundle`.
If the package's public surface does not re-export `scanBundle`, add it — the frontend and the CLI must import the **same** module, never a copy.

- [ ] **Step 2: Write the failing tests**

```ts
describe("preflight", () => {
  it("blocks on a forbidden API and names the file", () => {
    const r = preflight({ "dist/app.js": "fetch('/x')" }, validManifest);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe("dist/app.js");
    expect(r.errors[0].detail).toMatch(/no network/i);
  });

  it("blocks when code uses an undeclared permission", () => { /* storage use, [] declared */ });
  it("warns, but does not block, on a declared-but-unused permission", () => { /* ok === true */ });
  it("reports manifest violations as errors", () => { /* bad semver */ });
  it("lists what passed, not only what failed", () => { expect(r.passed.length).toBeGreaterThan(0); });
  it("gives every finding a help topic to link to", () => {
    for (const f of [...r.errors, ...r.warnings]) expect(f.helpTopic).toBeTruthy();
  });
  it("produces a raw report suitable for review_report", () => { /* JSON-serializable */ });
});
```

- [ ] **Step 3: Run and watch fail**

Run: `pnpm --filter @helios/desktop test preflight`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
export type FindingLevel = "error" | "warning" | "ok";
export interface PreflightFinding {
  level: FindingLevel;
  code: string;
  title: string;
  detail: string;      // plain English: what it means and what to do
  path?: string;
  helpTopic: HelpTopic;
}
export interface PreflightReport {
  ok: boolean;
  errors: PreflightFinding[];
  warnings: PreflightFinding[];
  passed: PreflightFinding[];
  raw: { scan: unknown; manifest: unknown; at: string };
}
export function preflight(texts: Record<string, string>, manifest: unknown): PreflightReport;
```

It composes `validateManifest` + `scanBundle` and maps each raw finding to an
explanation plus a `helpTopic`. The mapping table lives here and nowhere else.
`passed` is synthesized from the checks that produced no finding ("No network
calls", "No browser storage", "Permissions match the code", "Manifest valid").

- [ ] **Step 5: Run to green, then commit**

```bash
pnpm --filter @helios/desktop test preflight
git add apps/desktop/src/modules/marketplace/publish packages/plugin-sdk
git commit -m "feat(marketplace): pre-flight report sharing the review compliance scan"
```

---

### Task 5: `permissionDiff.ts` and `publishErrors.ts`

**Files:**
- Create: `.../publish/permissionDiff.ts` + `__tests__/permissionDiff.test.ts`
- Create: `.../publish/publishErrors.ts` + `__tests__/publishErrors.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// permissionDiff
it("marks newly requested permissions as added", ...)
it("treats a first version (prev === null) as all-added", ...)
it("flags high-trust additions", () => expect(d.hasHighTrust).toBe(true)); // engine:matlab
it("says nothing changed when nothing changed", () => expect(d.added).toHaveLength(0));

// publishErrors
it("turns the immutable-version raise into a bump instruction", () => {
  expect(explainPublishError(new Error('version 1.2.0 of x already exists (versions are immutable)')))
    .toMatch(/Bump `version` in manifest.json/);
});
it("explains an insufficient-privilege raise in terms of the capability", ...)
it("explains the 25 MiB ceiling", ...)
it("falls back to the raw message rather than swallowing an unknown error", ...)
```

- [ ] **Step 2–4: Fail → implement → green**

`permissionDiff(prev: string[] | null, next: string[]): PermissionDiff` reusing
`hasHighTrust` from `components/PermissionList`. `explainPublishError(e: unknown):
{ title: string; detail: string; helpTopic?: HelpTopic }` matching on the known
Postgres raise texts from `publish_plugin_version`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(marketplace): permission diff and human-readable publish errors"
```

---

### Task 6: `usePublish.ts` — the state machine

**Files:**
- Create: `.../publish/usePublish.ts` + `__tests__/usePublish.test.tsx`

- [ ] **Step 1: Failing tests** (mock `invoke`, the Supabase client, and `plugin-fs`)

```ts
it("walks idle -> packing -> preflight on a successful pack", ...)
it("stops at preflight and refuses to submit when there are blocking errors", ...)
it("uploads to the sha256 key with upsert:false", ...)
it("treats a duplicate-object upload error as success", ...)      // content-addressed
it("calls publish_plugin_version with the manifest, sha, bytes and subteam", ...)
it("keeps the staged path on an upload failure so retry does not re-pack", ...)
it("maps a publish error through explainPublishError", ...)
it("offers only subteams where the caller can publish", ...)
```

- [ ] **Step 2–4: Fail → implement → green**

States: `idle → packing → preflight → confirm → uploading → publishing → done | error`.
Upload path: read the staged file via `readFile` from `@tauri-apps/plugin-fs`,
`client.storage.from("plugins").upload(sha256, blob, { upsert: false })`, treat a
duplicate error as success. Then `client.schema("marketplace").rpc("publish_plugin_version", …)`.
On `done`, delete the staged file.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(marketplace): publish state machine"
```

---

### Task 7: The submit wizard UI

**Files:**
- Create: `.../publish/SubmitWizard.tsx`, `steps/ChooseFolderStep.tsx`, `steps/PreflightStep.tsx`, `steps/ConfirmStep.tsx`, `steps/SubmittedStep.tsx`
- Create: `.../authoring/helpContent.ts`, `.../authoring/HelpDrawer.tsx` (content lands now so findings have somewhere to link)
- Modify: `.../MarketplaceModule.tsx` — replace the disabled button at `:204`

- [ ] **Step 1: Failing component tests**

```tsx
it("renders the four steps and disables Next until a folder is packed", ...)
it("disables Submit while blocking errors are present", ...)
it("shows the added permissions prominently on an update", ...)
it("names the reviewers who can approve, and never implies self-approval", ...)
it("explains the missing capability instead of hiding the button", ...)
```

- [ ] **Step 2–4: Fail → implement → green**

Wire `Add to Marketplace` in the header (`IconUpload`, primary styling, no longer
`cursor-not-allowed`). Follow the existing modal conventions in
`components/InstallConsentModal.tsx`, and remember the global rule that modals sit
below the custom title bar.

- [ ] **Step 5: Screenshot-verify**

Render the wizard and **look at it** before calling it done. Check all four steps,
plus the blocking-error state.

- [ ] **Step 6: CHANGELOG + commit**

Add under `[Unreleased] → Added`:
`- Marketplace: **Add to Marketplace** — publish a plugin from inside Helios. Pick your plugin folder and Helios packs, checks, and submits it for review; the pre-flight runs the same compliance scan the reviewer does, so a green check here means a green check in review.`

```bash
git add apps/desktop/src CHANGELOG.md
git commit -m "feat(marketplace): submit wizard"
```

---

### Task 8: The Review tab

**Files:**
- Create: `.../data/installBundle.ts` (extract the shared download→verify→unpack from `useMarketplace.ts`)
- Modify: `.../data/useReview.ts` — add `useReviewInspect`, `useReviewPreview`
- Create: `.../review/ReviewView.tsx` + `__tests__/ReviewView.test.tsx`
- Modify: `.../MarketplaceModule.tsx` — the `Review` tab, badged, gated on `canAnywhere("marketplace.review")`

- [ ] **Step 1: Failing tests**

```ts
it("re-runs the compliance scan on the stored bytes, not the author's report", ...)
it("surfaces a mismatch when the author's report disagrees with the re-scan", ...)
it("blocks approve on the reviewer's own submission and explains why", ...)  // M3
it("passes the reviewer-generated report as p_report", ...)
it("labels a test-driven plugin as an unapproved preview", ...)
it("hides the Review tab when the caller can review nowhere", ...)
```

- [ ] **Step 2–4: Fail → implement → green**

`useReviewInspect` mints a signed URL for `bundle_sha256`, invokes
`inspect_plugin_bundle`, runs `preflight`, and returns the report plus a flag for
whether it disagrees with the stored `review_report`. `useReviewPreview` calls
`install_plugin_for_review` and reuses `installBundle`.

- [ ] **Step 5: Screenshot-verify, then commit**

Add under `[Unreleased] → Added`:
`- Marketplace: a **Review** tab for leads and VPs — pending submissions with a permission diff, an independent compliance re-scan of the uploaded bundle, and the option to test-drive a build before approving it.`

```bash
git commit -am "feat(marketplace): review tab with independent re-scan and test-drive"
```

---

### Task 9: Phase 1 verification gate

- [ ] Run `pnpm --filter @helios/desktop test` — the existing 47 marketplace tests plus the new ones, all green.
- [ ] Run `pnpm --filter @helios/desktop typecheck` — clean.
- [ ] Run `cargo test -p plugin-host` — green.
- [ ] Run `cd apps/desktop/src-tauri && cargo check` — clean.
- [ ] Screenshot the wizard and the Review tab side by side; confirm both read correctly at 1280×800.
- [ ] Confirm `CHANGELOG.md` has both `[Unreleased]` bullets.

---

# PHASE 2 — maintenance

*End state: authors manage their own plugins without asking anyone.*

### Task 10: `useMyPlugins.ts`

**Files:** Create `.../manage/useMyPlugins.ts` + `__tests__/useMyPlugins.test.tsx`

- [ ] **Step 1: Failing tests**

```ts
it("groups versions under their plugin, newest first", ...)
it("withdraws a pending version and refetches", ...)
it("yanks an approved version and refetches", ...)
it("toggles the recommended flag optimistically and rolls back on error", ...)
it("surfaces the server's refusal when the caller lacks publish on that subteam", ...)
```

- [ ] **Step 2–4:** Fail → implement over `my_published_plugins`, `withdraw_plugin_version`, `yank_plugin_version`, `set_plugin_recommended` → green.

- [ ] **Step 5:** `git commit -am "feat(marketplace): my-plugins data layer"`

### Task 11: `MyPluginsView.tsx`

**Files:** Create `.../manage/MyPluginsView.tsx` + tests; modify `MarketplaceModule.tsx` (tab gated on `canAnywhere("marketplace.publish")`)

- [ ] **Step 1: Failing tests**

```ts
it("shows a status chip per version", ...)
it("renders the rejection note inline", ...)
it("states that yanking leaves existing installs working", ...)   // exact wording matters
it("only offers withdraw on pending and yank on approved", ...)
it("shows an empty state that points at Start a new plugin", ...)
```

- [ ] **Step 2–5:** Fail → implement → green → screenshot-verify.

- [ ] **Step 6:** CHANGELOG under `Added`:
`- Marketplace: a **My Plugins** tab — every version you have published with its review status, inline reviewer notes, one-click withdraw of a pending submission, yank of a bad release, and the "recommended for my subteam" toggle.`

```bash
git commit -am "feat(marketplace): my plugins management tab"
```

---

# PHASE 3 — onboarding

*End state: someone who has never written code can start a plugin and hand it to their agent.*

### Task 12: `kit.ts` + `agentPrompt.ts`

**Files:** Create `.../authoring/kit.ts`, `.../authoring/agentPrompt.ts` + tests

- [ ] **Step 1: Failing tests**

```ts
it("embeds all six authoring docs", () => expect(Object.keys(KIT_DOCS)).toHaveLength(6));
it("embeds them verbatim from docs/plugin-authoring", ...)   // guards against drift
it("puts the folder path and plugin id in the agent prompt", ...)
it("tells the agent to read AUTHORING-KIT/README.md first", ...)
it("tells the agent to keep PLUGIN.md updated", ...)
it("ends by telling the human to click Add to Marketplace", ...)
```

- [ ] **Step 2–4:** Fail → implement. `kit.ts` uses
`import.meta.glob("../../../../../../docs/plugin-authoring/*.md", { query: "?raw", eager: true })`
— verify the relative depth against `vite.config.ts` root, and assert the count in
the test so a wrong path fails loudly instead of silently embedding nothing.

- [ ] **Step 5:** `git commit -am "feat(marketplace): embed the authoring kit and generate the agent prompt"`

### Task 13: `scaffold.ts`

**Files:** Create `.../authoring/scaffold.ts` + tests

- [ ] **Step 1: Failing tests**

```ts
it("writes manifest.json with the chosen id, name, 0.1.0 and empty permissions", ...)
it("writes a dist/index.html that awaits ready() and renders", ...)
it("writes all six kit docs into AUTHORING-KIT/", ...)
it("writes START-HERE.md and PLUGIN.md", ...)
it("refuses to overwrite a non-empty folder", ...)
it("produces a folder that packs and passes pre-flight", ...)   // the real acceptance test
```

The last test is the one that matters: scaffold → `preflight` → `ok === true`. A
starter project that fails its own pre-flight would be worse than none.

- [ ] **Step 2–4:** Fail → implement with `@tauri-apps/plugin-fs` (`mkdir`, `writeTextFile`) → green.

- [ ] **Step 5:** `git commit -am "feat(marketplace): scaffold a starter plugin project"`

### Task 14: Kit UI — Start a new plugin, Help drawer

**Files:** Modify `.../authoring/HelpDrawer.tsx`, `MyPluginsView.tsx` empty state, `SubmitWizard.tsx`

- [ ] **Step 1: Failing tests**

```ts
it("copies the agent prompt to the clipboard and confirms it", ...)
it("opens the drawer at the topic a pre-flight finding links to", ...)
it("explains each permission in plain words", ...)
```

- [ ] **Step 2–5:** Fail → implement → green → screenshot-verify the drawer and the scaffold flow.

- [ ] **Step 6:** CHANGELOG under `Added`:
`- Marketplace: **Start a new plugin** scaffolds a working starter project — manifest, hello-world build, and the full authoring kit as local files — then hands you a copy-paste prompt for your AI agent. A Help panel throughout explains the sandbox, the permissions, and the review process.`

```bash
git commit -am "feat(marketplace): authoring kit UI and contextual help"
```

---

## Final gate

- [ ] Full desktop suite green: `pnpm --filter @helios/desktop test`
- [ ] `pnpm --filter @helios/desktop typecheck` clean
- [ ] `cargo test -p plugin-host` green; `cargo check` clean in `src-tauri`
- [ ] Three `[Unreleased]` CHANGELOG bullets present
- [ ] Screenshots reviewed for the wizard, Review, My Plugins, and the Help drawer
- [ ] Migration **not** applied to prod yet — that is a deliberate, separate step via the Management API

## Deferred, deliberately

Ownership transfer between subteams · install counts · Phase 0.2 iframe self-nav
hardening · dynamic (runtime) review sandboxing · plugin update notifications.
