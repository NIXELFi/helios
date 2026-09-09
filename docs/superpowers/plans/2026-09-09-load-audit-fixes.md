# Load Audit Fixes (v5.7.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Supabase load and low-end-machine bottlenecks found in the 2026-09-09 load audit (memory: `helios-load-audit-0909`), ship as v5.7.1.

**Architecture:** Three independent waves. Wave 1 (parallel worktrees): SQL cursor RPCs + policy rewrite, Rust-side folder scan + streaming download, bundle/boot work that touches only leaf files. Wave 2 (integration branch): a module-activity context so hidden modules stop polling, throttled focus handlers, lazy module chunks in the Shell. Wave 3 (parallel worktrees): Vault catalog de-duplication with a single realtime feed, and PM incremental sync from realtime payloads. Wave 4: merge, verify, prod migrations, release.

**Tech Stack:** React 18 + TypeScript (Vite, vitest + jsdom), Tauri 2 (Rust: tokio, reqwest, sha2, flate2, walkdir), Supabase (PostgREST, Realtime, Postgres RLS), pnpm workspace, CHANGELOG-driven release workflow.

**Ground rules for every task**
- Integration branch: `perf/load-audit-0909` in worktree `C:/Users/nmurray/Documents/Helios/worktrees/perf-5.7.1`. Wave 1 and Wave 3 tasks run in their own worktree/branch created off that branch and are merged back into it with a merge commit.
- Every task adds bullets under `## [Unreleased]` in root `CHANGELOG.md` (Keep a Changelog groups). The release gate fails without them.
- TDD where the code is pure or hookable: write the failing test first, run it, implement, run again, commit. Test commands: `pnpm --filter @helios/desktop test -- <path>` (vitest, jsdom), `pnpm --filter @helios/widgets test`, `cargo test -p helios-desktop` (from `apps/desktop/src-tauri`), `pnpm typecheck` at the root.
- Never edit source files with PowerShell `Get-Content`/`Set-Content` (encoding gotcha). Use the Edit tool.
- Do not run `supabase db push`. Migrations are applied to prod in Task 12 through the Management API.
- The RLS test suite (`infra/pdm-supabase/tests`) needs a local Supabase and only runs in CI. Write the tests anyway; CI on the pushed branch is the gate.
- Keep every existing public API working unless the task says otherwise; the app must stay usable against a database that does not yet have the new RPCs (fallbacks are specified where that matters).

---

## Wave 1 — parallel

### Task 1: Cursor RPCs, policy rewrite, bridge RPC (SQL + clients)

Worktree: `git worktree add -b perf/sql-cursors ../perf-sql perf/load-audit-0909` (run from `worktrees/perf-5.7.1`).

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260909100000_pdm_vault_cursor_rpc.sql`
- Create: `infra/pdm-supabase/supabase/migrations/20260909100100_pm_workspace_cursor_rpc.sql`
- Create: `infra/pdm-supabase/supabase/migrations/20260909100200_pm_read_policies_initplan.sql`
- Create: `infra/pdm-supabase/supabase/migrations/20260909100300_pdm_my_vault_ids_read_policies.sql`
- Create: `infra/pdm-supabase/supabase/migrations/20260909100400_pdm_bridge_live_files_rpc.sql`
- Create: `infra/pdm-supabase/tests/perf-cursor-rpcs.test.ts` (copy the harness style of `infra/pdm-supabase/tests/org-default-deny.test.ts`)
- Modify: `apps/desktop/src/modules/vault/data/vault-cursor.ts` (`fetchVaultCursor`)
- Modify: `apps/desktop/src/modules/pm/lib/workspace-cursor.ts` (`fetchPmCursor`)
- Modify: `apps/desktop/src/modules/vault/data/useBridgeSync.ts:183-194` (files pull)
- Test: `apps/desktop/src/modules/vault/data/__tests__/vault-cursor.test.ts` (extend or create), `apps/desktop/src/modules/pm/lib/__tests__/workspace-cursor.test.ts` (extend or create)

**Why:** the four Vault counts and five PM probe requests run a membership function per row (versions count: 1,434 ms mean, 32% of all DB time). A `security definer` RPC checks membership once and counts without RLS (11 ms measured). The `(select …)` rewrite makes Postgres evaluate `auth.uid()` and `can_read_pm` once per statement instead of once per row.

- [ ] **Step 1: Write `20260909100000_pdm_vault_cursor_rpc.sql`**

```sql
-- One request instead of four exact-count requests, and no per-row RLS
-- function calls: membership is checked ONCE, then the counts run as the
-- definer. Counts are a change signal only (they include other users'
-- unpublished drafts, which RLS would hide) — the client compares
-- signatures, it never displays these numbers.
create or replace function pdm.vault_cursor(p_vault_id uuid)
returns table (live_files bigint, versions bigint, live_folders bigint, active_locks bigint)
language sql stable security definer set search_path = pdm, public as $$
  select
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.files f where f.vault_id = p_vault_id and f.deleted_at is null) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.versions v join pdm.files f on f.id = v.file_id where f.vault_id = p_vault_id) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.folders fo where fo.vault_id = p_vault_id and fo.deleted_at is null) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.locks l join pdm.files f on f.id = l.file_id where f.vault_id = p_vault_id and l.released_at is null) else 0 end;
$$;
revoke all on function pdm.vault_cursor(uuid) from public, anon;
grant execute on function pdm.vault_cursor(uuid) to authenticated;
```

- [ ] **Step 2: Write `20260909100100_pm_workspace_cursor_rpc.sql`**

```sql
create index if not exists idx_tasks_updated_at on pm.tasks (updated_at desc);

create or replace function pm.workspace_cursor()
returns table (tasks bigint, tasks_updated_at timestamptz, activity bigint, task_owners bigint, task_links bigint)
language sql stable security definer set search_path = pm, public as $$
  select
    (select count(*) from pm.tasks),
    (select max(updated_at) from pm.tasks),
    (select count(*) from pm.activity),
    (select count(*) from pm.task_owners),
    (select count(*) from pm.task_links)
  where pm.can_read_pm((select auth.uid()));
$$;
revoke all on function pm.workspace_cursor() from public, anon;
grant execute on function pm.workspace_cursor() to authenticated;
```

A non-member gets zero rows; the client treats that as "no access, nothing changed" (see Step 6).

- [ ] **Step 3: Write `20260909100200_pm_read_policies_initplan.sql`**

Recreate every `members read <table>` SELECT policy with the cheap whole-org test first and both helpers wrapped in scalar subqueries, so `can_read_pm` runs once per statement and `is_project_member` only runs for users who fail it. Tables and their project expression (taken from the deployed catalog on 2026-09-09):

| table | project expression |
|---|---|
| activity, calendar_events, milestones, pages, tasks, team_memberships, vendors | `project_id` |
| projects | `id` |
| blocks | `(select pages.project_id from pm.pages where pages.id = blocks.page_id)` |
| build_records, task_comments, task_links, task_milestones, task_owners, task_part_link, task_subteams | `(select tasks.project_id from pm.tasks where tasks.id = <table>.task_id)` |
| task_dependencies | `(select tasks.project_id from pm.tasks where tasks.id = task_dependencies.successor_id)` |

Template for each (write all 18 out explicitly in the file; no DO-block generation):

```sql
drop policy if exists "members read tasks" on pm.tasks;
create policy "members read tasks" on pm.tasks for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );
```

Also rewrite `pm.database_views` "members read views" to
`((select pm.can_read_pm((select auth.uid()))) or pm.is_project_member((select auth.uid()), project_id)) and (owner_id = (select auth.uid()) or is_shared)`
and `pm.role_memberships` "role_memberships_select_self" to `user_id = (select auth.uid())`.
Semantics are unchanged: same predicates, same truth table.

- [ ] **Step 4: Write `20260909100300_pdm_my_vault_ids_read_policies.sql`**

```sql
-- Set of vault ids the caller may read: a GLOBAL role row (vault_id null)
-- grants every vault, otherwise exactly the listed vaults. Equivalent to
-- pdm.is_member_in(v) for every v that exists in pdm.vaults, but evaluated
-- ONCE per statement as a hashed subplan instead of once per row.
create or replace function pdm.my_vault_ids()
returns setof uuid language sql stable security definer set search_path = pdm, public as $$
  select v.id from pdm.vaults v
  where exists (
    select 1 from pdm.user_roles ur
    where ur.user_id = (select auth.uid()) and (ur.vault_id is null or ur.vault_id = v.id)
  );
$$;
revoke all on function pdm.my_vault_ids() from public, anon;
grant execute on function pdm.my_vault_ids() to authenticated;

drop policy if exists files_read on pdm.files;
create policy files_read on pdm.files for select to authenticated
  using (vault_id in (select pdm.my_vault_ids())
         and (published_at is not null or created_by = (select auth.uid())));

drop policy if exists folders_read on pdm.folders;
create policy folders_read on pdm.folders for select to authenticated
  using (vault_id in (select pdm.my_vault_ids()));

drop policy if exists versions_read on pdm.versions;
create policy versions_read on pdm.versions for select to authenticated
  using (pdm.file_vault_id(file_id) in (select pdm.my_vault_ids()));

drop policy if exists locks_read on pdm.locks;
create policy locks_read on pdm.locks for select to authenticated
  using (pdm.file_vault_id(file_id) in (select pdm.my_vault_ids()));

drop policy if exists refs_read on pdm.refs;
create policy refs_read on pdm.refs for select to authenticated
  using (pdm.version_vault_id(parent_version_id) in (select pdm.my_vault_ids()));
```

Check `20260610100000_pdm_vault_scoped_reads.sql` for any other read policy built on `is_member_in` over a row column (audit_log etc.) and rewrite it the same way only if it is one of the tables the app pages through; leave write policies alone.

- [ ] **Step 5: Write `20260909100400_pdm_bridge_live_files_rpc.sql`**

```sql
-- The add-in bridge needs id/vault/folder/name/latest for every live file
-- the caller can read (published, or their own draft) across all vaults.
-- Under RLS that was 14 pages at ~207 ms each; as a definer with the
-- membership set computed once it is one indexed scan.
create or replace function pdm.bridge_live_files()
returns table (id uuid, vault_id uuid, folder_id uuid, name text, latest_version_id uuid)
language sql stable security definer set search_path = pdm, public as $$
  select f.id, f.vault_id, f.folder_id, f.name, f.latest_version_id
  from pdm.files f
  where f.deleted_at is null
    and f.vault_id in (select pdm.my_vault_ids())
    and (f.published_at is not null or f.created_by = (select auth.uid()))
  order by f.id;
$$;
revoke all on function pdm.bridge_live_files() from public, anon;
grant execute on function pdm.bridge_live_files() to authenticated;
```

- [ ] **Step 6: Client — `fetchVaultCursor` uses the RPC with a fallback**

In `vault-cursor.ts`, keep the existing four-count implementation as `fetchVaultCursorLegacy` and make `fetchVaultCursor` call `client.rpc("vault_cursor", { p_vault_id: vaultId })` (default schema is `pdm`). Map `{live_files, versions, live_folders, active_locks}` to `VaultCursor`. If the RPC errors with a "function does not exist" signal (`error.code === "PGRST202"` or `"42883"`, or message matches `/could not find the function|does not exist/i`), fall back to the legacy path once and remember it for the process (`let rpcMissing = false` at module scope) so a database without the migration keeps working. Any other error still throws (the caller runs a full reconcile). Zero rows → throw `new Error("vault_cursor returned no row")`.

Write the failing tests first in `apps/desktop/src/modules/vault/data/__tests__/vault-cursor.test.ts`: (a) RPC success maps fields; (b) PGRST202 falls back to the four counts and the second call skips the RPC; (c) a 500 from the RPC throws. Use a hand-rolled client stub (`{ rpc: vi.fn(), from: vi.fn() }`) like the existing tests in this folder.

- [ ] **Step 7: Client — `fetchPmCursor` uses the RPC with a fallback**

Same pattern in `workspace-cursor.ts`: `client.schema("pm").rpc("workspace_cursor")` → first row → `PmCursor` (`tasksUpdatedAt = row.tasks_updated_at ?? ""`). Zero rows (non-member) → return all zeros with `tasksUpdatedAt: ""` (matches what RLS returned before). Missing-function fallback to the legacy five requests, remembered per process. Tests mirror Step 6.

- [ ] **Step 8: Client — bridge structure uses `bridge_live_files`**

In `useBridgeSync.ts` `reloadStructure`, replace the files `fetchAllRows` builder with `() => (client.rpc("bridge_live_files") as any).order("id", { ascending: true })` (PostgREST supports `order` and `Range` on set-returning functions, so `fetchAllRows` paging still works). On the missing-function signal fall back to the previous builder. Keep vaults/folders as they are.

- [ ] **Step 9: RLS suite test**

`infra/pdm-supabase/tests/perf-cursor-rpcs.test.ts`: as a global-role member, `vault_cursor` returns counts equal to `select count(*)` per table for the seeded vault; as a per-vault member of vault A it returns zeros for vault B; as a no-role user `workspace_cursor` returns no rows; `bridge_live_files` returns exactly the rows the same user gets from `select id from pdm.files where deleted_at is null` under RLS (equivalence check); files/versions/locks visibility for a per-vault editor is unchanged by the policy rewrite (reuse the assertions from the existing per-vault-roles test).

- [ ] **Step 10: Typecheck, unit tests, CHANGELOG, commit**

```bash
pnpm typecheck
pnpm --filter @helios/desktop test -- vault-cursor workspace-cursor
git add -A && git commit -m "perf(db): cursor RPCs, initplan read policies, bridge RPC"
```

CHANGELOG `[Unreleased]` → Changed: "Vault and PM background change-checks are now a single server call each instead of four or five row-counting requests, and the row-level read policies evaluate membership once per query instead of once per row. The database work behind an idle Helios drops by roughly half."

### Task 2: Rust folder scan and streaming download

Worktree: `git worktree add -b perf/rust-io ../perf-rust perf/load-audit-0909`.

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/scan_folder.rs`
- Create: `apps/desktop/src-tauri/src/commands/download.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs:286-318` (register `commands::scan_folder::scan_vault_folder`, `commands::download::download_object_to_temp`)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `walkdir = "2"`, `sha2 = { workspace = true }`, `flate2 = "1"`, `uuid = { workspace = true }`; enable `reqwest` feature `stream` and add `futures-util = "0.3"`, `tokio` feature `fs`)
- Modify: `apps/desktop/src/modules/vault/data/useLocalFolderScan.ts` (walk → invoke, JS walk kept as fallback)
- Modify: `apps/desktop/src/modules/vault/data/useDownloadVersion.ts` (`downloadVersionOnce` → invoke, JS path kept as fallback)
- Test: Rust unit tests inside both modules (`#[cfg(test)]` with `tempfile`-free temp dirs under `std::env::temp_dir()`), `apps/desktop/src/modules/vault/data/__tests__/local-scan-invoke.test.ts`, `apps/desktop/src/modules/vault/data/__tests__/download-invoke.test.ts`

**Why:** the scan walks with one `stat` IPC per file every 30 s and re-reads and re-hashes every file through the webview on every launch (the sha cache is a `useRef`). Downloads hold whole files in JS memory and cross IPC as one buffer.

- [ ] **Step 1: `scan_vault_folder` command (Rust, TDD)**

Signature: `#[tauri::command] pub async fn scan_vault_folder(app: tauri::AppHandle, root: String) -> Result<ScanResult, String>` running the walk in `tauri::async_runtime::spawn_blocking`.

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry { pub basename: String, pub relative_path: String, pub absolute_path: String, pub sha256: String, pub size_bytes: u64, pub readonly: bool }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult { pub root_exists: bool, pub entries: Vec<ScanEntry>, pub open_in_sw: Vec<String> }
```

Rules (mirror `useLocalFolderScan.ts:55-130` exactly): skip names starting with `.`; a name starting with `~$` adds `<relPrefix>/<rest>` to `open_in_sw` and is not an entry; never follow symlinks (dir or file); depth cap 64; unreadable entries are skipped; paths are joined with `/` onto the root string as given (the JS built `${dir}/${e.name}`; keep byte-for-byte compatible so `relativePath` keys match the rest of the Vault code). `readonly` from `metadata.permissions().readonly()`.

Hash cache: `app.path().app_local_data_dir()?/scan-cache/<hex sha256 of root>.json`, a map `absolute_path → {mtime_ms, size, sha256}`. Load before the walk, hit when mtime and size match, otherwise hash with a 1 MiB streaming buffer (`sha2::Sha256`), and write the file back after the walk only if anything changed (drop entries for paths no longer present). A corrupt or missing cache file is treated as empty.

Unit tests (pure walk function `scan_dir(root, cache) -> (ScanResult, cache)` taking a `&mut HashMap`): builds a temp tree with a hidden file, a `~$Part.SLDPRT` sidecar, a nested dir, one read-only file; asserts entries, `open_in_sw`, readonly, sha of a known payload, and that a second scan with an unchanged file does not re-hash (count hashing calls via a counter passed in or by checking the cache is reused — simplest: mutate the file's contents without changing mtime/size is not reliable; instead assert the cache map returned from scan 1 is consulted by scan 2 by pre-seeding it with a fake sha for the file and asserting scan 2 reports the fake sha).

- [ ] **Step 2: JS — `useLocalFolderScan` calls the command**

Replace the `stat(rootPath)` + `walk(...)` block inside the scan effect with:

```ts
const res = await scanViaNative(rootPath);   // invoke("scan_vault_folder", { root: rootPath })
```

`scanViaNative` returns `{ rootExists, entries: LocalFile[], openInSw: Set<string> }`. If `invoke` throws with a message containing `window.__TAURI` / "not a Tauri" / `invoke is not a function` (non-Tauri: vitest), fall back to the existing JS `walk` (keep the function and the `shaCacheRef`; the JS path is now the fallback only). Everything else in the hook (rootMissing, hadFilesRef, paused semantics, watcher, focus, interval) stays as it is. Delete the JS-side `stat(rootPath)` pre-check in the native path (the command reports `rootExists`).

Test `local-scan-invoke.test.ts`: mock `@tauri-apps/api/core` `invoke` to resolve a `ScanResult` and assert the hook publishes files/openInSw/rootMissing accordingly; a second test where `invoke` rejects with "not a Tauri environment" asserts the JS fallback path runs (mock `@tauri-apps/plugin-fs` like the existing scan tests do).

- [ ] **Step 3: `download_object_to_temp` command (Rust, TDD)**

```rust
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DownloadRequest { pub url: String, pub bearer: String, pub apikey: String, pub dest_path: String, pub expected_sha256: String }
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct DownloadResult { pub temp_path: String, pub bytes: u64, pub was_gzip: bool }
#[tauri::command] pub async fn download_object_to_temp(req: DownloadRequest) -> Result<DownloadResult, String>
```

Behaviour: GET `url` with `Authorization: Bearer <bearer>` and `apikey: <apikey>` using the shared `reqwest::Client` (build one lazily in a `OnceLock`). Non-2xx → `Err(format!("HTTP {status}: {body-prefix}"))` (the JS retry regex keys on `502|503|504|timeout|gateway|network`, so include the status number). Stream the body: peek the first two bytes; if `1f 8b` wrap a `flate2::read::MultiGzDecoder` around a blocking reader over the stream (do the whole transfer inside `spawn_blocking` with `reqwest::blocking`, simplest correct option — enable the `blocking` feature); otherwise copy raw. Write to `<dest_path>.<uuid v4>.part` while feeding `sha2::Sha256`; parent dir `create_dir_all`. On finish compare hex sha to `expected_sha256` (lowercase). Mismatch after gzip → re-download once as raw (the legacy "raw file that starts with the gzip magic" case) and compare again; still wrong → delete the temp and `Err("sha256 mismatch: expected …, got …")`. Never rename: the JS side owns the rename so its abort guard and read-only handling stay exactly as they are.

Unit tests: a local `std::net::TcpListener` mini HTTP server on a thread that serves (a) gzip bytes of a known payload, (b) raw bytes, (c) a 504; assert temp file contents/sha, `was_gzip`, and the error text contains `504`.

- [ ] **Step 4: JS — `downloadVersionOnce` uses the command**

In `useDownloadVersion.ts` inside the retry loop, replace the `client.storage.from(BUCKET).download(...)` + gunzip + hash + `writeFile(tmpPath)` block with:

```ts
const { temp } = await nativeDownload(client, sha, destPath);   // invoke("download_object_to_temp", { req })
```

where `nativeDownload` builds `url = \`${supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath(sha)}\`` (`supabaseUrl = (client as any).supabaseUrl ?? import.meta.env.VITE_SUPABASE_URL`), `bearer = (await client.auth.getSession()).data.session?.access_token` (fall back to the anon key when there is no session, matching what supabase-js sends), `apikey = import.meta.env.VITE_SUPABASE_ANON_KEY`. Then continue with the existing code from the `mkdir` onward but rename the returned temp path instead of writing one (`setReadonly(destPath, false)` → abort check → `rename(temp, destPath)`; on abort or failure `remove(temp)`). Keep the whole current JS implementation as `downloadVersionOnceInWebview` and use it when `invoke` is unavailable (non-Tauri) — the tests for the existing behaviour keep passing against that function. The retry/backoff and transient regex stay in the outer loop.

Test `download-invoke.test.ts`: mock `invoke` to resolve `{tempPath, bytes, wasGzip}` and plugin-fs `rename`; assert rename is called with the temp and dest, and that an aborted signal after the invoke removes the temp and returns `{ok:false,error:"aborted"}`.

- [ ] **Step 5: Bulk/auto-sync worker counts**

With the transfer off the webview, `useAutoSync.ts:398` stays at 4 and `useBulkDownload.ts:66` stays at 8; just update the comment on `useBulkDownload.ts:57-64` to say the bytes no longer cross the webview.

- [ ] **Step 6: Build, test, CHANGELOG, commit**

```bash
cd apps/desktop/src-tauri && cargo test && cd ../../..
pnpm typecheck && pnpm --filter @helios/desktop test -- local-scan download
git add -A && git commit -m "perf(vault): native folder scan with persisted hash cache; streaming downloads in Rust"
```

CHANGELOG → Changed: "The Vault's local-folder scan and file downloads now run in the native layer. Launch no longer re-reads and re-hashes every local file through the app window, and a 200-file sync no longer holds the files in memory." Fixed: "Rescans of large vault folders no longer stutter the interface on slower laptops."

### Task 3: Leaf bundle and boot fixes

Worktree: `git worktree add -b perf/bundle-boot ../perf-bundle perf/load-audit-0909`.

**Files:**
- Modify: `packages/widgets/src/gps-track/render.tsx:1-3, ~249` (lazy maplibre)
- Modify: `apps/desktop/src/help/pages.ts`, `apps/desktop/src/help/HelpModal.tsx:50-70` (lazy wiki)
- Modify: `apps/desktop/src/modules/vault/data/compression.ts:20,43-59` (fflate instead of pako), `apps/desktop/package.json` (remove `pako`, `@tanstack/react-query`), lockfile via `pnpm install`
- Modify: `apps/desktop/src/components/Tile.tsx:20-40`, `apps/desktop/src/App.tsx:1463-1478` (memo + stable `onSelect`)
- Modify: `apps/desktop/src/App.tsx:198-325` (paint-first boot)
- Test: `apps/desktop/src/help/__tests__/pages.test.ts` (create), `apps/desktop/src/modules/vault/data/__tests__/compression.test.ts` (extend or create), `apps/desktop/src/__tests__/boot-order.test.ts` (create, pure helper test)

- [ ] **Step 1: gps-track loads maplibre on first mount**

Replace the static `import maplibregl … from "maplibre-gl"` and the CSS import with `import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl"` plus a module-level `let maplibrePromise: Promise<typeof import("maplibre-gl")> | null` and `function loadMaplibre() { return (maplibrePromise ??= Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]).then(([m]) => m.default ?? m)); }`. In the effect that constructs the map (line ~249) await `loadMaplibre()` first, guard with a `cancelled` flag so an unmounted widget never creates a map. Render nothing map-related until loaded (the canvas overlay code is unaffected). `pnpm --filter @helios/widgets test` must stay green.

- [ ] **Step 2: Wiki pages load on demand**

`pages.ts`: change the glob to non-eager (`import.meta.glob("../../../../docs/wiki/*.md", { query: "?raw", import: "default" })` → `Record<string, () => Promise<string>>`). Export `WIKI_INDEX: WikiPageMeta[]` (`slug`, `title` derived from the slug only: `README` → "Home", else strip the `NN-` prefix and turn dashes into spaces, `order`), `loadPage(slug): Promise<WikiPage | undefined>` (memoised per slug; title upgraded from the first `# ` heading once content is loaded) and `loadAllPages(): Promise<WikiPage[]>`. Keep `HOME_SLUG`. `HelpModal.tsx`: `active` becomes state filled by an effect calling `loadPage(slug)` (show the previous page until the new one arrives); the search filter calls `loadAllPages()` once the user types and filters on the loaded set (until then filter titles from `WIKI_INDEX`). `navigate` checks `WIKI_INDEX` instead of `getPage`.

Test `pages.test.ts`: `WIKI_INDEX` has README first, titles derived as specified; `loadPage("README")` resolves with content and an H1-derived title; unknown slug → undefined.

- [ ] **Step 3: One zlib**

`compression.ts`: replace the pako import with `import { gzipSync, gunzipSync } from "fflate"`; `gzipBytes` fallback → `gzipSync(bytes)`, `gunzipIfNeeded` fallback → `gunzipSync(bytes)`. Remove `pako` and `@tanstack/react-query` from `apps/desktop/package.json`, run `pnpm install`, confirm `grep -r "from \"pako\"\|react-query" apps packages --include=*.ts --include=*.tsx` is empty. Test: round-trip a 1 MB random buffer through `gzipBytes` → `gunzipIfNeeded` with `CompressionStream` stubbed to undefined so the fallback runs.

- [ ] **Step 4: Tile memo and stable select**

Wrap `Tile` in `React.memo`. Change the prop to `onSelect: (id: string) => void` and call `onSelect(spec.id)` inside; in `App.tsx` create `const onSelectTile = useCallback((id: string) => setSelectedTileId(id), [])` and pass `onSelect={onSelectTile}`. Confirm `updateTile` is already a `useCallback` (it is used as `onChange`); if not, make it one. Existing Tile tests must pass.

- [ ] **Step 5: Paint-first Logs boot**

Extract a pure helper in `apps/desktop/src/lib/boot-order.ts`:

```ts
export const MAX_AUTO_REOPEN = 12;
/** Split the recents list into the one session to load before first paint and
 *  the rest to load in the background. The first is the first recent whose
 *  saved meta is not hidden (falls back to recents[0]); the rest keep list
 *  order and are capped so a long history never makes launch slow. */
export function planRecentsBoot(recents: string[], isHidden: (path: string) => boolean): { first: string | null; rest: string[] }
```

Test it in `boot-order.test.ts` (empty list, all hidden → first = recents[0], cap applied to rest, order preserved).

Then restructure the effect in `App.tsx:198-325`: load bundled → `planRecentsBoot(loadRecentSessions(), p => loadSessionMeta(userSessionIdFor(p))?.visible === false)` → load `first` (existing `loadUserSession` + `removeRecentSession` on failure) → `applySessionMeta`, math channels, `setSessions`, `setPrimaryId`, lap-selection restore exactly as today (this is where the LoadingScreen clears) → then, without awaiting before the commit above, `Promise.allSettled(rest.map(loadUserSession…))` → for the fulfilled ones `applySessionMeta`, `applyMathChannels` (merge the error maps into `mathErrors` with `setMathErrors(prev => …)`), then `setSessions(prev => mergeSessionsWithColors(prev, loaded))`; rejected ones call `removeRecentSession(path)`. Progress labels: keep the existing `setLoadProgress` calls for the first phase with `total = bundled.length + 1 + 2`; the background phase does not touch the loading screen. Check `loadSessionMeta`/`userSessionIdFor` import names in `lib/session.ts` and `lib/load-user-session.ts` before writing.

- [ ] **Step 6: Build size check, tests, CHANGELOG, commit**

```bash
pnpm typecheck && pnpm --filter @helios/desktop test && pnpm --filter @helios/widgets test
cd apps/desktop && npx vite build --logLevel warn && ls -S dist/assets/*.js | head -5
```

Expected: the maplibre chunk is separate (a `maplibre-gl-*.js` of ~780 KB) and the wiki pages are individual small chunks. Commit `perf(app): lazy maplibre and wiki, one zlib, memoised tiles, paint-first Logs boot`.

CHANGELOG → Changed: "Logs opens as soon as your primary session is loaded; the other recent sessions come in behind it instead of holding up the first paint (at most 12 are reopened automatically)." "The map widget and the built-in help pages are loaded the first time they are used instead of at launch."

---

## Wave 2 — on `perf/load-audit-0909` after merging Tasks 1–3

Merge order: `git merge --no-ff perf/sql-cursors`, then `perf/rust-io`, then `perf/bundle-boot`. Resolve `CHANGELOG.md` by keeping every bullet. Run `pnpm typecheck && pnpm --filter @helios/desktop test` after the merges before starting Task 4.

### Task 4: Module activity, throttled focus, lazy Shell modules

**Files:**
- Create: `apps/desktop/src/shell/module-activity.tsx`
- Create: `apps/desktop/src/lib/use-throttled-focus.ts`
- Modify: `apps/desktop/src/Shell.tsx:4-11, 311-385`
- Modify: `apps/desktop/src/modules/pm/PmModule.tsx:26-35, 330-432`
- Modify: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx:150-161, 413`
- Modify: `apps/desktop/src/modules/marketplace/MarketplaceModule.tsx:69-74`
- Test: `apps/desktop/src/shell/__tests__/module-activity.test.tsx`, `apps/desktop/src/lib/__tests__/use-throttled-focus.test.ts`

- [ ] **Step 1: `module-activity.tsx` (TDD)**

```tsx
const Ctx = createContext<boolean>(true);           // no provider → "active" (tests, stand-alone mounts)
export function ModuleActivityProvider({ active, children }: { active: boolean; children: ReactNode })
export function useModuleActive(): boolean           // context value
export function useDocumentVisible(): boolean        // document.visibilityState !== "hidden", updated on visibilitychange
export function useModuleLive(): boolean             // useModuleActive() && useDocumentVisible()
```

Tests: default true without a provider; provider false → false; flipping `document.visibilityState` (define via `Object.defineProperty(document, "visibilityState", …)` then dispatch `visibilitychange`) updates `useDocumentVisible`.

- [ ] **Step 2: `use-throttled-focus.ts` (TDD)**

`useThrottledFocus(handler: () => void, minIntervalMs: number, enabled = true)`: adds a `window` `focus` listener; runs `handler` only if at least `minIntervalMs` passed since the last run (first run always allowed); keeps the handler in a ref. Test with `vi.useFakeTimers()` and dispatched focus events: two focuses within the window run the handler once; after the window, again.

- [ ] **Step 3: Shell — providers and lazy modules**

In `Shell.tsx` replace the static module imports (Vault, Cfd, Pm, Games, Amethyst, Marketplace, Org) with `React.lazy(() => import("./modules/vault").then(m => ({ default: m.VaultModule })))` etc. (`LogsApp` stays static). Wrap the `<main>` children in one `<Suspense fallback={<ModuleLoading />}>` where `ModuleLoading` is a centred `text-helios-dim` "Loading…" div (same classes the vault Notice uses). Wrap each module element in `<ModuleActivityProvider active={active === "<id>"}>`. `GamesModule` keeps its `paused` prop as well.

- [ ] **Step 4: PM — gate polling on live, focus → probe**

In the refresh effect (`PmModule.tsx:330-432`): add `const live = useModuleLive()` at component level and mirror it into a `liveRef`. `probe()` and the backstop tick return early when `!liveRef.current`. Add an effect on `[live]` that, when `live` flips to true, calls the effect's `probe` (expose it through a ref set inside the main effect) so a returning user catches up with one cheap request. Change `PM_BACKSTOP_MS` to `600_000`. Replace the focus handler: `useThrottledFocus(() => { void probeRef.current?.(); }, 15_000)` and drop the full refresh on focus (the probe detects task changes; the long-tail tables are covered by the backstop). Realtime events while `!live` set `staleWhileHiddenRef = true` instead of refreshing; the live-flip effect runs `refresh()` when that flag is set (and clears it). Keep every existing guard (`hydrated`, `inFlightWrites`, `writeEpoch`, `retryPending`).

- [ ] **Step 5: Vault — cursor and rescans follow live**

`BrowseScreen.tsx`: `const live = useModuleLive()`; `useVaultCursor(vaultId ?? undefined, { intervalMs: VAULT_POLL_MS, onChange: reconcile, enabled: live })`; `useLocalFolderScan(vaultFolderPath, { intervalMs: live ? LOCAL_RESCAN_INTERVAL_MS : 0, rescanOnFocus: live, watchFs: true, paused: syncBusy })`. The filesystem watcher stays on so auto-sync keeps working in the background. Inside `useLocalFolderScan` the focus listener must use `useThrottledFocus(…, 10_000, rescanOnFocus)` instead of a raw listener.

- [ ] **Step 6: Marketplace focus**

`MarketplaceModule.tsx:69-74` → `useThrottledFocus(refetch, 60_000, useModuleLive())`.

- [ ] **Step 7: Typecheck, tests, CHANGELOG, commit**

```bash
pnpm typecheck && pnpm --filter @helios/desktop test
git add -A && git commit -m "perf(shell): modules stop polling when hidden; throttled focus refresh; lazy module chunks"
```

CHANGELOG → Changed: "Vault and Project Manager stop their background checks while you are in another module or the window is hidden, and catch up with one small request when you come back. Coming back to the window no longer re-downloads the whole workspace." "Modules other than Logs are loaded the first time you open them, which makes launch lighter."

---

## Wave 3 — parallel worktrees off `perf/load-audit-0909` (after Task 4 is merged)

### Task 5: Vault catalog once, targeted reconcile, one realtime feed

Worktree: `git worktree add -b perf/vault-catalog ../perf-vault perf/load-audit-0909`.

**Files:**
- Create: `apps/desktop/src/modules/vault/data/vault-files-context.tsx`
- Create: `apps/desktop/src/modules/vault/data/vault-events.ts` (+ test)
- Modify: `apps/desktop/src/modules/vault/data/useAllFiles.ts` (add `refreshFolder`, `refreshIds`, `mergeRows` helper exported for tests)
- Modify: `apps/desktop/src/modules/vault/data/useVaultCursor.ts` (`onChange(prev, next)`)
- Modify: `apps/desktop/src/modules/vault/data/useVaultRealtime.ts` (bus subscriber), `useNotifications.ts:100-130` (bus subscriber)
- Modify: `apps/desktop/src/modules/vault/VaultHome.tsx:40-50`, `BrowseScreen.tsx:106-110, 170-180, 286-290, 330-360, 395-413`, `HistoryScreen.tsx:22`, `InsightsScreen.tsx:29`
- Delete: `apps/desktop/src/modules/vault/data/useFiles.ts` (after all consumers move)
- Test: `apps/desktop/src/modules/vault/data/__tests__/all-files-merge.test.ts`, `vault-events.test.ts`, extend `apply-events.test.ts` if helpers change

- [ ] **Step 1: `mergeRows` (pure, TDD)**

`mergeRows(current: VaultFile[], incoming: VaultFile[], scope: { folderId: FolderId | null } | { ids: FileId[] }): VaultFile[]` — replaces rows by id, appends new ones, and within a folder scope removes rows of that folder that are absent from `incoming` (they moved or were deleted). Returns the same reference when nothing changed. Tests: replace, add, remove-in-scope, untouched-outside-scope, no-op identity.

- [ ] **Step 2: `useAllFiles` gains `refreshFolder` / `refreshIds`**

Both run one `FILE_WITH_LATEST_SELECT` query (folder: `.eq("vault_id", id).is("deleted_at", null)` plus `.eq("folder_id", f)` or `.is("folder_id", null)`; ids: `.in("id", ids)`) and `patch` through `mergeRows`. Keep `refetch` (full) for the cases below.

- [ ] **Step 3: Provide once from VaultHome**

`vault-files-context.tsx`: `VaultFilesProvider` calls `useAllFiles(vaultId)` once and provides the result; `useVaultFiles()` throws outside a provider. `VaultHome` wraps its tree and passes the same `allFiles` to `useNotifications`. `BrowseScreen` and `InsightsScreen` use `useVaultFiles()`; `HistoryScreen` and `BrowseScreen` derive folder lists with a small `useFolderFiles(folderId | null)` hook (filter `folder_id === folderId && deleted_at == null`, sort by `name` then `id`, memoised). Then delete `useFiles.ts`. In `BrowseScreen`: `refetchFiles` → `() => refreshFolder(selectedFolder)`; remove `patchFiles` calls (the whole-vault patch already covers the folder view); `filesLoading`/`filesError` come from the shared hook.

- [ ] **Step 4: Targeted reconcile**

`useVaultCursor` passes `(prev, next)` to `onChange` (`prev` null on the error fallback). In `BrowseScreen` replace `reconcile` with: liveFiles differs → `refetch()` + `refetchDeleted()`; versions differs → query `versions` `select("file_id,created_at")` `.gt("created_at", lastVersionSeen)` (track the max `latest.created_at` across `allFiles` in a ref) → `refreshIds(fileIds)`; liveFolders differs → `refetchFolders()` + `refetchDeletedFolders()`; activeLocks differs → `refetchLocks()`; `prev === null` (probe failed) → everything, as today.

- [ ] **Step 5: One realtime channel per vault**

`vault-events.ts`: a tiny per-vault bus (`subscribe(vaultId, handler) → unsubscribe`, `publish(vaultId, table, payload)`). Move the channel from `useVaultRealtime` into `useVaultRealtimeFeed(vaultId)` mounted once in `VaultHome` (same reconnect/backoff code), which publishes every `postgres_changes` payload for versions/locks/files/folders to the bus. `useVaultRealtime(vaultId, cb)` becomes a bus subscriber with the same callback API; `useNotifications` subscribes to the bus instead of opening `vault-notifs:<id>`. Test the bus (fan-out to two subscribers, unsubscribe, vault isolation).

- [ ] **Step 6: Typecheck, tests, CHANGELOG, commit**

CHANGELOG → Changed: "The Vault reads its file catalog once per vault instead of twice, refreshes only the part that changed when a teammate edits, and keeps one live connection per vault instead of two."

### Task 6: PM incremental sync from realtime

Worktree: `git worktree add -b perf/pm-incremental ../perf-pm perf/load-audit-0909`.

**Files:**
- Modify: `apps/desktop/src/modules/pm/lib/data.ts` (split into `fetchWorkspaceRaw`, `buildWorkspace`, keep `loadWorkspace`)
- Create: `apps/desktop/src/modules/pm/lib/pm-apply.ts` (+ `__tests__/pm-apply.test.ts`)
- Modify: `apps/desktop/src/modules/pm/lib/pm-realtime.ts` (pass `{ table, payload }` to `onEvent`)
- Modify: `apps/desktop/src/modules/pm/PmModule.tsx` (raw cache, apply path, snapshot debounce)
- Test: `apps/desktop/src/modules/pm/lib/__tests__/data-build.test.ts` (buildWorkspace is pure; assert it equals today's `loadWorkspace` output for a fixture)

- [ ] **Step 1: Split `loadWorkspace`**

`RawWorkspace` = the un-transformed arrays exactly as unwrapped today (`projectsRaw, subteams, subsystems, users, tasksRaw, depsRaw, milestones, pages, blocks, vendors, comments, links, build, events, activity, rolesRaw, hiddenSubteamsRaw`). `fetchWorkspaceRaw(client)` does the reads; `buildWorkspace(raw)` is the existing transform verbatim; `loadWorkspace(client) = buildWorkspace(await fetchWorkspaceRaw(client))`. Also export `fetchTaskRowsByIds(client, ids)` (the tasks select with its three embeds, `.in("id", ids)`).

- [ ] **Step 2: `applyPmEvents` (pure, TDD)**

`applyPmEvents(raw, events: PmEvent[]): { raw: RawWorkspace; refetchTaskIds: string[]; full: boolean }` where `PmEvent = { table: string; eventType: "INSERT"|"UPDATE"|"DELETE"; new: Row|null; old: Row|null }`:
- `task_comments`, `task_links`, `milestones`, `calendar_events`, `subteams`: upsert by `id` / remove by `old.id`.
- `task_dependencies`: key `(predecessor_id, successor_id)`.
- `project_hidden_subteams`: key `(project_id, subteam_id)`.
- `activity`: INSERT prepends and caps at 250 (the fetch limit); UPDATE/DELETE upsert/remove by id.
- `tasks`, `task_subteams`, `task_owners`: collect `task_id ?? id` into `refetchTaskIds` (DELETE of a task removes it from `tasksRaw` immediately).
- Missing `old.id` on a DELETE, or an unknown table → `full: true`.
Returns the same `raw` reference when nothing changed. Tests cover each table, the cap, DELETE without old row, and identity on no-op.

- [ ] **Step 3: PmModule wiring**

Keep `rawRef` next to the existing effect state; every `loadWorkspace` path stores `raw` (`fetchWorkspaceRaw` → `buildWorkspace`). `subscribePmRealtime` now hands `onEvent({ table, payload })`; PmModule buffers events and, after the 150 ms debounce, runs `applyIncremental()`: same guards as `refresh()` (`hydrated`, `inFlightWrites === 0`, `!running`, else `retryPending`); `applyPmEvents` → if `full` → `refresh()`; else if `refetchTaskIds.length` → `fetchTaskRowsByIds` and splice into `tasksRaw` (ids not returned are removed: RLS hid them or they were deleted) → `buildWorkspace` → `hydrateFrom(ws)` with `preserveWriteError: true` → debounced `saveSnapshot`. Replace the direct `saveSnapshot` calls with a 2 s trailing debounce (`saveSnapshotDebounced`), flushed on unmount. The cursor-probe change path still calls `refresh()` (full) — that is the safety net for events realtime missed.

- [ ] **Step 4: Typecheck, tests, CHANGELOG, commit**

CHANGELOG → Changed: "Project Manager applies a teammate's edit directly from the live event instead of re-downloading the whole workspace; the board no longer flickers when someone else saves." Fixed: "A background refresh no longer re-writes the local cache on every change."

---

## Wave 4 — integrate and release (on `perf/load-audit-0909`, then `main`)

### Task 7: Merge, verify, push, CI

- [ ] Merge `perf/vault-catalog` and `perf/pm-incremental` with `--no-ff`; resolve CHANGELOG by keeping all bullets under one `[Unreleased]` with merged groups.
- [ ] `pnpm typecheck` (11 packages), `pnpm -r --workspace-concurrency=1 --filter '!@helios/pdm-supabase' test`, `cargo test` in `apps/desktop/src-tauri`, `npx vite build` and record chunk sizes.
- [ ] Push the branch; watch CI (`gh run list --branch perf/load-audit-0909`, `gh run watch <id>`), including the "Vault RLS/RPC security tests" job. Fix and re-push until green. If the RLS suite fails only on the `my_vault_ids` policy migration, drop that single migration (keep the RPCs) and note it in the changelog and memory.

### Task 8: Prod migrations, then release

- [ ] Apply the five migrations to prod in order through the Management API query endpoint (`node <scratchpad>/sbq.mjs -f <file>`; the helper sends `read_only: true` — remove that flag for these calls), then record each version in `supabase_migrations.schema_migrations` the way `helios-migration-apply-management-api` describes. Verify: `select pdm.vault_cursor('<SDM25 id>')`, `select * from pm.workspace_cursor()` with a user's claims set, `select count(*) from pdm.bridge_live_files()` with claims set, and `pg_policies` shows the new `using` text. Keep a rollback file (`docs/superpowers/plans/2026-09-09-rollback.sql`) that restores the previous policy bodies from `20260610100000_pdm_vault_scoped_reads.sql` and `20260603110000_pm_role_capability_mapping.sql` and drops the three functions.
- [ ] Merge `perf/load-audit-0909` into `main` with a merge commit (repo style) in `worktrees/release`; `node scripts/bump-version.mjs 5.7.1`; commit `chore(release): 5.7.1 - lighter on Supabase and on slow machines`; tag `v5.7.1`; push `main` and the tag.
- [ ] Watch the Release run. If two drafts appear for the tag, apply the repair recipe from memory `helios-release-duplicate-draft-race` (move assets, delete the secondary, `gh run rerun --failed`). Confirm 11 assets, `latest.json` for all four targets, Slack post ok.
- [ ] Update memory (`helios-load-audit-0909` → shipped state, gotchas) and the memory index.
