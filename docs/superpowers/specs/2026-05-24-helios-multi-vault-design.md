# Helios Multi-Vault Support — Design

**Date:** 2026-05-24
**Status:** Draft — design complete, plan pending
**Scope:** Promote Helios Vault from de-facto single-vault (`vaults?.[0]`) to true multi-vault, so SDM26 can live alongside SDM27 on the (newly-upgraded) Supabase Plus project.

---

## 1. Background & current state

The Supabase schema is already multi-vault. `pdm.vaults` has been a real table since Phase 1 (`infra/pdm-supabase/supabase/migrations/20260507000000_pdm_schema.sql`), and every downstream table (`folders`, `files`, `versions`, `locks`) carries `vault_id`. Every data hook in `apps/desktop/src/modules/vault/data/` already accepts a `vaultId` argument: `useFolders`, `useFiles`, `useAllFiles`, `useVaultRealtime`, etc.

The UI is the bottleneck:

- `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx:40` — `const vault = vaults?.[0];`
- `apps/desktop/src/modules/vault/screens/HistoryScreen.tsx:15` — `const vaultId = vaults?.[0]?.id;`

There is no concept of an "active vault" anywhere in the client. `useVaultFolder` stores one global local-folder path in `localStorage` under `helios.vault.localFolder`, so even if we surfaced both vaults, sync would collide between SDM27 and SDM26 working copies.

Roles today are global: `pdm.user_roles (user_id, role)` with role ∈ `{admin, editor, viewer}`. `pdm.is_admin()` checks this single row. There is no per-vault role concept.

## 2. Goals

1. A user can see and switch between every vault their role permits.
2. The active vault drives every screen (Browse, History, Who-has-what, Settings).
3. Each vault has its own local sync folder — switching vaults switches working directory.
4. Admins can create, rename, and (carefully) delete vaults from Settings.
5. Roles become per-vault: an admin can grant editor on SDM27 and viewer on SDM26 to the same user. Global admin remains (super-admin who sees all vaults and can manage role assignments).

### Non-goals (out of scope for this work)

- Cross-vault search or aggregate views.
- Migrating existing data between vaults.
- Per-folder permissions inside a vault.
- Audit log UI for vault management actions (the underlying DB audit already exists).

## 3. Architecture

### 3.1 Active-vault state (client)

Add `apps/desktop/src/modules/vault/data/useActiveVault.ts`:

- `localStorage` key `helios.vault.activeVaultId` holds the chosen vault id.
- Hook returns `{ activeVaultId, setActiveVaultId, activeVault }` where `activeVault` is the resolved row from `useVaults()`.
- On mount: if stored id is missing or no longer in the user's `useVaults()` result, fall back to the first available vault and persist that choice.
- Cross-window sync via the `storage` event, same pattern as `useVaultFolder`.

Every screen that today reads `vaults?.[0]` reads `activeVault` instead. This is a mechanical replacement at two call sites.

### 3.2 Per-vault local sync folder

`useVaultFolder` currently stores a single string. Replace with a map keyed by `vaultId`:

- Storage key remains `helios.vault.localFolder` but value becomes JSON: `{ [vaultId: string]: string }`.
- API becomes `useVaultFolder(vaultId)` → `{ path, setPath, clear }` scoped to that vault.
- Migration on first load: if the existing value is a bare string (legacy), assign it to the current active vault id and rewrite as a map.
- All call sites pass the active vault id. `BrowseScreen` already has it, no signature changes elsewhere.

### 3.3 Per-vault roles (backend)

New migration `20260524000000_pdm_vault_roles.sql`:

```sql
create table pdm.vault_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  vault_id uuid not null references pdm.vaults(id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  primary key (user_id, vault_id)
);

create or replace function pdm.user_role_for_vault(p_vault_id uuid)
returns text language sql stable security definer as $$
  -- Global admin sees every vault as admin.
  select case
    when pdm.is_admin() then 'admin'
    else (
      select role from pdm.vault_roles
      where user_id = auth.uid() and vault_id = p_vault_id
    )
  end;
$$;
```

RLS update: `vaults`, `folders`, `files`, `versions`, `locks` SELECT policies become `pdm.user_role_for_vault(vault_id) is not null`. Write policies (insert/update on `files`, `folders`) require `pdm.user_role_for_vault(vault_id) in ('admin','editor')`. Lock policies allow editors and admins. The existing global `pdm.user_roles` is preserved as the *global admin* table — anyone with role `admin` there is super-admin across every vault.

Data backfill: seed `pdm.vault_roles` from the existing `pdm.user_roles` × `pdm.vaults` Cartesian product, mapping the global role one-for-one to every existing vault. After this migration, behavior for SDM27 is unchanged for current users.

### 3.4 Role hooks (client)

- `useMyRole()` becomes `useMyRoleFor(vaultId)`, calling `pdm.user_role_for_vault(vault_id)`. Returns `MyRole` as today.
- `useIsAdmin()` keeps its global-admin meaning — global admins always see admin-only chrome (create/rename/delete vault, manage roles). This is the only "super-admin" affordance.
- All current `useMyRole()` consumers pass the active vault id.

### 3.5 Vault management RPCs

Three new RPCs, all gated by `pdm.is_admin()`:

- `pdm_rename_vault(p_vault_id uuid, p_new_name text)` — updates `vaults.name`, audited.
- `pdm_delete_vault(p_vault_id uuid, p_confirm_name text)` — requires the caller to retype the vault name as a safety interlock; cascades delete via existing FKs.
- `pdm_grant_vault_role(p_user_id uuid, p_vault_id uuid, p_role text)` and `pdm_revoke_vault_role(p_user_id uuid, p_vault_id uuid)`.

Client wrappers: `useRenameVault`, `useDeleteVault`, `useGrantVaultRole`, `useRevokeVaultRole`.

## 4. UI changes

### 4.1 Vault switcher

A dropdown lives at the top of `NavRail` (above Browse/History/Who/Settings). The control:

- Shows the active vault name.
- Opens a menu listing every vault from `useVaults()`, with a check on the active one.
- Below the list: a "+ New vault" item visible only to global admins, opening an inline create-vault form (same code path as today's empty-state form, just promoted).

When the active vault changes, every screen re-renders against the new `vaultId`. No reload required — all the data hooks already re-query when their `vaultId` dep changes.

ASCII sketch:

```
┌────────────────────┐
│ ▾ SDM27            │  ← dropdown trigger
├────────────────────┤
│  Browse            │
│  History           │
│  Who has what      │
│  Settings          │
└────────────────────┘
```

Open state:

```
┌────────────────────┐
│ ▾ SDM27            │
├────────────────────┤
│  ✓ SDM27           │
│    SDM26           │
│  ─────────────     │
│  + New vault       │ (admins only)
├────────────────────┤
│  Browse            │
│  ...               │
```

### 4.2 Settings screen restructure

Settings becomes vault-aware. New top-to-bottom layout:

1. **Account** — unchanged.
2. **Local vault folder** — now scoped to the active vault. The picker stores into the per-vault map. A small header shows "Local folder for SDM27" so context is obvious.
3. **Vault management** (admin only): list of all vaults with rename / delete buttons; "+ New vault" form.
4. **People & roles** (admin only): two surfaces, because a single users × vaults matrix scales badly past ~5 users / 3 vaults.
   - **Per-vault roster** — accessed by clicking a vault in the Vault management list. Shows that vault's users and their roles. This composes cleanly as vaults grow and is the day-to-day surface.
   - **Users list** — flat list of every user across the team, with a global-admin toggle. This is the rare-use surface for granting/revoking super-admin.

Non-admins see only sections 1 and 2.

### 4.3 BrowseScreen & HistoryScreen

Replace the `vaults?.[0]` reads with `useActiveVault()`. The empty-vault state in BrowseScreen goes away — vault creation moves to the switcher and Settings. The folder-tree header still shows `{activeVault?.name}` but as a static label, not a hidden vault picker.

### 4.4 WhoHasWhatScreen

Already vault-agnostic in its query (uses `useLocks()` with no vault filter). Add a `vault_id` filter so locks list is scoped to the active vault. Add a vault filter dropdown above the table for admins who want to peek at activity in a vault they can also access.

## 5. Data flow

```
useActiveVault()  ──→ activeVaultId
       │
       ├──→ useFolders(activeVaultId)
       ├──→ useAllFiles(activeVaultId)
       ├──→ useVaultRealtime(activeVaultId, ...)
       ├──→ useMyRoleFor(activeVaultId)
       ├──→ useVaultFolder(activeVaultId) ──→ vaultRoot (per-vault)
       │                                          │
       │                                          ├──→ useLocalFolderScan(vaultRoot)
       │                                          └──→ useAutoSync(..., vaultRoot)
       └──→ NavRail switcher state
```

Auto-sync, realtime, and the file scanner all already key on the values they receive — no internal changes, just plumbing the active vault through.

## 6. Edge cases & error handling

- **User loses access to active vault** (admin revokes role mid-session): `useActiveVault` detects the missing id in the next `useVaults()` refetch and falls back to the first available. If none, show the empty-state ("You don't have access to any vault yet — contact an admin").
- **Switching mid-sync**: `useAutoSync` already cancels in-flight work when its `vaultId` dep changes; this is the same race the realtime hook handles. Verify behavior with a test.
- **Local folder collision**: if the user accidentally points two vaults at the same local folder, warn at pick time (compare against the existing map) but don't hard-block — the user might be intentionally reusing a workspace.
- **Vault deletion**: cascade via FKs handles DB cleanup. The local folder for that vault is preserved on disk (we never delete user files); the per-vault folder mapping entry is dropped from `localStorage`.
- **Rename collision**: `pdm.vaults.name` already has a unique constraint, so the RPC surfaces the error naturally; client shows it inline.

### 6.1 Auto-sync scope

Auto-sync runs for the **active vault only**, not every vault the user can see. Rationale: syncing N vaults eagerly doubles disk and bandwidth and means every vault background-downloads forever; users will not be working in two vaults at once. When the user switches into a vault for the first time, a "warm" sync runs to catch its local working directory up. `useAutoSync` already keys on `vaultId`, so the implementation is "only render one `<VaultSyncSection>`, parameterized by the active vault" — no internal hook change.

### 6.2 First-login default

A user with access to 2+ vaults and no stored `activeVaultId` defaults to the **most-recently-created** vault (`max(created_at)` from `useVaults()` results). No picker screen — the choice is reversible via the switcher and is immediately persisted to `localStorage`. Users with access to zero vaults see the "contact an admin" empty state.

### 6.3 Realtime channel scope

`useVaultRealtime(activeVaultId, ...)` already opens one channel per vault id. We deliberately only subscribe to the active vault, not every accessible vault, so realtime traffic scales with sessions × 1, not sessions × vaults. The cost is that switching vaults takes one round-trip to resubscribe, which is fine.

### 6.4 Vault deletion: storage object cleanup

FK cascade handles the relational tables but **does not** delete blobs from Supabase Storage. `pdm_delete_vault` must explicitly enumerate `versions.sha256` for the deleted vault and remove the corresponding `vault-objects/{prefix}/{sha}` objects — *except* for SHAs still referenced by versions in other vaults (Helios's content-addressed storage is dedupe-shared across vaults). The RPC computes the set difference inside one transaction before deleting both DB rows and storage objects. A botched delete would leak blobs and silently eat Plus-plan quota, so this gets its own test that asserts storage object count drops by the right amount.

### 6.5 Phase B RLS migration safety

Rewriting RLS on live tables is the riskiest step in the whole project. Two safeguards in the migration:

1. **Dual-policy interval.** Create new per-vault policies under different names (`*_v2`) alongside the existing ones. Verify the new policies behave correctly via in-transaction smoke checks (`set local role authenticated; set local request.jwt.claims = ...; select count(*) from pdm.files;`). Only after smoke check passes, drop the old policies. If the smoke check fails, the transaction rolls back and nothing changes.
2. **Backfill before flipping.** `pdm.vault_roles` is populated from `pdm.user_roles × pdm.vaults` *before* the policy swap, so the new policies have data to evaluate against from row zero. No window where an existing user's queries return empty because their row is missing.

## 7. Testing

- **Unit:** `useActiveVault` fallback behavior, `useVaultFolder` map migration from legacy string.
- **Component:** NavRail switcher (open/select/create), Settings vault management list.
- **Integration:** RLS — user with editor on SDM27 and viewer on SDM26 sees both vaults but can only check out files from SDM27. Global admin sees everything.
- **Migration:** Backfill from `pdm.user_roles` → `pdm.vault_roles` for an existing dataset produces equivalent visibility.

## 8. glassypdm → SDM26 import

The SDM26 dataset lives on a self-hosted glassyPDM instance (S3 + Postgres). Pulling the whole thing to local disk and re-checking it in through the Helios client is not viable — the dataset is large and the user doesn't want a full local working copy of the legacy PDM. The plan is **direct server-to-server import** with file-by-file streaming so the local footprint is bounded by one file at a time.

### 8.1 What glassyPDM looks like

Schema (verbatim from `glassypdm-server/schema.sql`):

- `project` — analog of a Helios vault.
- `file (projectid, path, ...)` — current pointer per logical file; `path` is the full POSIX-style path including subfolders (e.g. `Chassis/Subframe/x.sldprt`). No folder table; the directory structure is implicit in the path string.
- `filerevision (projectid, path, commitid, filehash, numchunks, filesize, ...)` — version history.
- `commit` — groups revisions, has author + comment + timestamp.
- `chunk (filehash, chunkindex, blockhash, blocksize)` — files are split into ordered chunks.
- `block (blockhash, s3key, blocksize)` — content-addressed deduplicated chunks; `s3key` is the blake3 hash, blob lives at that key in S3.

So reassembling a file = look up `filerevision.filehash` → join `chunk` ordered by `chunkindex` → fetch each `block.s3key` from S3 → concatenate.

### 8.2 What Helios expects

- Bucket `vault-objects`, object key `{sha256[0:2]}/{sha256}`, blob is the **gzipped** whole file.
- Hash is **SHA-256** of the *uncompressed* bytes (not blake3, not the gzipped bytes).
- Folders are real rows in `pdm.folders` with a parent chain.
- Files inserted via the `pdm_add_and_lock(p_vault_id, p_folder_id, p_name, p_sha256, p_size, p_comment)` RPC (atomic file+version+lock) — but for migration we want a *no-lock* import variant; see 8.5.

### 8.3 Tool shape

A standalone CLI lives at `crates/glassypdm-import/` (Rust, single binary). Why Rust:
- Shares Helios's `helios-core` types and `pdm-client` crate, so the same `pdm_add_and_lock`-style RPCs are typed.
- Streaming + hashing + gzip are first-class.
- Single static binary the user can run on a laptop or a small VM.

Inputs (from `--config` or env):
- `GLASSYPDM_DB_URL` (Postgres connection string for the legacy server's DB).
- `GLASSYPDM_S3_*` (endpoint, region, bucket, access/secret).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS — service-role-only; documented as the one place a service key is used).
- `--source-project <id>` (which glassypdm project to import).
- `--target-vault <name>` (which Helios vault to import into — created if missing).
- `--dry-run` (count files + report sizes, no writes).
- `--resume` (skip files whose path already exists with matching sha256 in the target vault).

### 8.4 Algorithm (per file)

```
for each current file in glassypdm.project={id}:
  1. fetch latest filerevision (filehash, filesize, numchunks)
  2. ensure target folder hierarchy in pdm.folders (split path on '/')
  3. compute sha256 by streaming:
        for chunkindex in 0..numchunks:
          GET block from glassypdm S3 by s3key
          feed bytes into:
            - sha256 hasher
            - gzip encoder writing to a temp file (or BufWriter)
  4. if pdm.versions row with this sha256 already exists for this file row:
        skip (already imported, idempotent)
  5. else if object {sha[:2]}/{sha} not in Supabase Storage:
        upload gzipped temp file via storage.from('vault-objects').upload()
  6. insert pdm.files row if missing (or get existing by name+folder+vault)
  7. insert pdm.versions row (file_id, sha256, size_bytes, comment=glassypdm commit comment, author='migration')
  8. update pdm.files.latest_version_id
```

All of step 5–8 happens inside one Postgres transaction per file via a new `pdm_import_version` RPC (see 8.5). Peak local disk = one gzipped file. Peak memory = sha256 state + gzip encoder state + one chunk buffer (~4MB).

### 8.5 New `pdm_import_version` RPC + `import_metadata` column

#### 8.5.1 Schema addition

Add an optional `import_metadata jsonb` column to `pdm.versions`. Stores full provenance for any version that came from somewhere other than a Helios check-in. NULL for native versions. Indexed via `jsonb_path_ops` so we can query by source later.

```sql
alter table pdm.versions add column import_metadata jsonb;
create index versions_import_metadata_idx on pdm.versions using gin (import_metadata jsonb_path_ops);
```

Existing UI (which has no awareness of this column) keeps rendering versions as today. Future UI can show provenance badges.

#### 8.5.2 The RPC

`pdm.add_and_lock` (in `20260511001100_pdm_add_and_lock_idempotent.sql`) is already idempotent on `(folder_id, name, sha256)` and could almost be reused, but it has four behaviors wrong for migration:

1. It acquires a `pdm.locks` row for the caller — the importer isn't a user.
2. It writes `author_id = auth.uid()` — we want NULL (no Supabase user maps to a Clerk user).
3. It hardcodes `version_num = 1` — wrong if we ever import full history.
4. It can't write `created_at` or `import_metadata`.

Sibling RPC:

```sql
create function pdm.import_version(
  p_vault_id uuid,
  p_folder_id uuid,
  p_name text,
  p_sha256 text,
  p_size bigint,
  p_comment text,
  p_created_at timestamptz,    -- preserve original glassyPDM commit timestamp
  p_import_metadata jsonb      -- full source provenance (see 8.5.3)
) returns jsonb                  -- { file_id, version_id, version_num, created }
language plpgsql
security definer
set search_path = pdm, public
as $$ … $$;
```

Behavior:
- **No lock acquisition.**
- **`author_id`**: always written NULL. The original author display name lives in `import_metadata.source_commit_author_display` (preserved); there's no value in confusing it with Helios's notion of `author_id` (which is a Supabase user FK). The `pdm.versions.author_id` FK has `on delete set null` already (per `20260511000800`).
- **`created_at`**: written into `versions.created_at` so the audit history matches the original commit timestamp.
- **`version_num`**: `coalesce(max(version_num), 0) + 1` for the file. Supports both current-only and full-history.
- **`import_metadata`**: stored as-is.
- **Idempotency**: identical sha256 on `(folder_id, name)` → no-op, returns existing version_id and `created: false`. Re-runs of the importer are safe.
- **Authorization**: requires service-role. Check via `current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'`. Authenticated users (even admins) cannot call this RPC — it's a back-door specifically for one-way data import.
- **Public proxy**: `public.pdm_import_version(...)` with `revoke execute from public, anon, authenticated; grant execute to service_role;`.

#### 8.5.3 `import_metadata` payload (glassyPDM source)

Per the user's directive to preserve as much info as possible:

```json
{
  "source": "glassypdm",
  "source_server": "io.sdm.glassypdm.org",
  "source_project_id": 13,
  "source_project_name": "SDM-26",
  "source_path": "Suspension\\CAD\\Solidworks\\Models\\ARBs\\Rears\\26-07-MS-ARB-Bearing Cup 1.SLDPRT",
  "source_filehash_blake3": "b68014436ad31bc41fe8953d476c18611852a75de0c96c7ce1dd576b8cc5824e",
  "source_filerevision_id": 41657,
  "source_filerevision_number": 1,
  "source_commit_id": 1552,
  "source_commit_number": 845,
  "source_commit_author_display": "Hunter Coakley",
  "source_commit_author_clerk_id": "user_2yYO0BeFIi2ITJJzTdIX4E3YvR5",
  "source_commit_comment": "",
  "source_commit_timestamp_unix": 1778088491,
  "imported_at": "2026-05-25T00:42:11Z",
  "imported_by_email": "nmmurra3@asu.edu"
}
```

Every field is optional in the JSON schema sense but always populated when imported from glassyPDM. Captures: provenance (server, project, path), original content addressing (blake3 hash + revision id + revision number), original commit context (id, sequential number, author display + Clerk id, comment, timestamp), and import audit (when, by whom). If we ever lose glassyPDM access, every version still has full provenance — a Helios-only restore reconstructs *everything we ever knew*.

### 8.6 glassyPDM data access

**Decision (revised after empirical probe 2026-05-24):** the importer talks to glassyPDM's HTTP API only. No direct Postgres, no direct S3 credentials. Rationale:

- Any team member with glassyPDM project access can run the importer with just their normal login. No DB URL to provision, no S3 IAM keys to share. Lower coordination cost.
- The HTTP API surfaces everything we need: project list, file list at HEAD or any commit, per-file chunk URLs (presigned S3 GETs valid 48 hours), and full commit metadata including author display names.
- The presigned-URL extra round-trip cost is one POST per file (not per chunk) — for SDM-26's 4,451 live files that's 4,451 quick API calls vs. 4,451 S3 GETs anyway; the API call is negligible overhead.

Auth: Clerk dev-instance JWT. The importer authenticates the same way the desktop client does (Clerk Frontend API password sign-in → session → JWT) and refreshes ~hourly. Creds via a local file outside the repo. Server URL configurable but defaults to `io.sdm.glassypdm.org`.

#### 8.6.1 Endpoints actually used

| Purpose | Endpoint | Notes |
|---|---|---|
| List user's projects | `GET /project/user` | Returns `[{id, name, team, team_id}]`. Captures the user's Clerk `user_id` from the response (used in `/store/download` body). |
| Project info | `GET /project/info?pid={pid}` | `{title, teamId, teamName, initCommit, canManage}`. |
| Latest commit | `GET /project/latest?pid={pid}` | Returns the global `commit_id` (not `commit_number`). Pass `"latest"` to the status endpoint to avoid an extra lookup. |
| HEAD file list | `GET /project/status/by-id/{pid}/latest` | Body is a JSON-encoded string containing an array of `{frid, path, commitid, filehash, changetype, blocksize}`. **`blocksize` is `filesize` aliased in the SQL** — it's the whole-file size. **`changetype` ∈ {1=Create, 2=Update, 3=Delete}** — filter `!= 3` for current state. |
| Historical file list | `GET /project/status/by-id/{pid}/{commit_no}` | Same shape, snapshot at a given commit. |
| Per-commit detail | `GET /commit/by-id/{commit_id}` | Returns `{description: {commit_id, commit_number, num_files, author, comment, timestamp}, files: [{filerevision_id, path, filerevision_number, changetype, filesize, commit_id, project_id}]}`. The `author` field is the resolved Clerk display name. |
| Commit history | `GET /commit/select/by-project/{pid}?offset={n}` | Paginated, 8 per page. Returns `{num_commits, commits: [{commit_id, commit_number, num_files, author, comment, timestamp}]}`. |
| Chunk URLs for a file | `POST /store/download` | Body: `{project_id, path, commit_id, user_id}`. Returns `{file_hash, commit_id, file_path, file_chunks: [{s3_url, block_hash, file_hash, chunk_index}]}`. URLs are 48h-valid AWS S3 presigned GETs — keep them in-memory only, never log. |

Two things to watch:

- **`/store/download` request body uses `\` paths** (verbatim from glassyPDM). The importer must send the path exactly as returned by `/project/status/by-id/.../latest` (backslashes intact). Only the folder hierarchy build on the Helios side normalizes to `/`.
- **`commit_id` in `/store/download`** is the **global commit primary key**, not the per-project `commit_number`. The status endpoint already returns the correct `commitid` per row — use that, never the `commit_number`.

#### 8.6.2 Building the "import plan"

Single pass at the start of a run:

1. `GET /project/user` → look up the project by name (default `SDM-26`), capture its `id`, and the caller's Clerk `user_id`.
2. `GET /project/status/by-id/{pid}/latest` → file list at HEAD.
3. Filter rows where `changetype == 3` (deleted). Zero-byte files are extremely rare on this dataset (SDM-26 has none) but skipped defensively.
4. Build the unique set of `commitid` values across the surviving rows. Batch-fetch `/commit/by-id/{commit_id}` for each (with light per-host concurrency, e.g. 4) to resolve author display names and timestamps once per commit.
5. The plan is now an in-memory list of `{path, filehash, blocksize, commitid, commit_author, commit_timestamp, commit_comment, source_filerevision_id}` ready to feed the per-file pipeline.

This shape works for HEAD-only import (Phase C v1) and is the same shape full-history mode would emit (Phase C v2), just expanded by walking every commit instead of one snapshot.

### 8.7 Per-file streaming algorithm

Locations and file names are preserved exactly. Path normalization happens only when splitting into Helios's `pdm.folders` tree (which uses one row per directory level); the original backslash path is kept verbatim in `import_metadata.source_path`.

```rust
// 1. Resolve target folder hierarchy. Convert backslashes to forward slashes
//    for splitting; the final file `name` is the last segment unchanged.
//    Collapse runs of separators ("a\\b\\\\c" -> ["a","b","c"]) and strip
//    leading separators.
let normalized = source_path.replace('\\', "/");
let mut segs: Vec<&str> = normalized
    .split('/')
    .filter(|s| !s.is_empty())
    .collect();
let name = segs.pop().expect("non-empty path");           // byte-identical to glassyPDM file name
let folder_id = ensure_folder_hierarchy(vault_id, &segs).await?; // None if root

// 2. Fetch chunk URLs via /store/download.
let chunks = glassy.store_download(pid, source_path, commit_id, my_user_id).await?;

// 3. Stream chunks → sha256 + gzip into a temp file. One chunk in flight at a time.
let mut sha   = Sha256::new();
let mut gz    = GzEncoder::new(tempfile()?, Compression::default());
let mut total = 0u64;
for chunk in chunks.iter().sorted_by_key(|c| c.chunk_index) {
    let mut body = http.get(&chunk.s3_url).send().await?.bytes_stream();
    while let Some(part) = body.next().await {
        let part = part?;
        sha.update(&part);
        gz.write_all(&part)?;
        total += part.len() as u64;
    }
}
ensure_eq!(total, blocksize as u64);   // belt-and-braces; mismatch = aborted run
let sha_hex = hex::encode(sha.finalize());
let gz_path = gz.finish()?.into_temp_path();

// 4. Idempotency probe BEFORE the upload — saves bandwidth on resumes.
if helios.versions().exists_for(folder_id, name, &sha_hex).await? {
    return Ok(Skipped);
}

// 5. Storage upload via service-role PUT to `{sha[:2]}/{sha}`. Matches the
//    layout in apps/desktop/src/modules/vault/data/useAddLocalFile.ts.
helios.storage().upload_service_role(&sha_hex, gz_path).await?;

// 6. Single-tx file + version. import_metadata carries everything glassyPDM gave us.
let meta = json!({
    "source": "glassypdm",
    "source_server": glassy.server_host(),
    "source_project_id": pid,
    "source_project_name": project_name,
    "source_path": source_path,                       // backslashes preserved
    "source_filehash_blake3": filehash,
    "source_filerevision_id": frid,
    "source_filerevision_number": filerevision_number,
    "source_commit_id": commit_id,
    "source_commit_number": commit_number,
    "source_commit_author_display": commit_author_display,
    "source_commit_author_clerk_id": commit_author_clerk_id,
    "source_commit_comment": commit_comment,
    "source_commit_timestamp_unix": commit_timestamp,
    "imported_at": now_utc_iso8601(),
    "imported_by_email": importer_email,
});

helios.rpc().pdm_import_version(
    vault_id, folder_id, name, &sha_hex, total,
    /* p_comment        */ commit_comment.unwrap_or_default(),
    /* p_created_at     */ commit_timestamp_to_tstz(commit_timestamp),
    /* p_import_metadata*/ meta,
).await?;
```

Peak local disk = one gzipped file. Peak memory = sha256 state + gz encoder state + one HTTP read buffer (~256 KB). Streams hold no whole-file copy.

### 8.8 Importer crate (`crates/glassypdm-import/`)

```
crates/glassypdm-import/
  Cargo.toml          # bins = ["glassypdm-import"]
  src/
    main.rs           # clap CLI: import / dry-run / verify
    config.rs         # creds file + flags + env
    glassy/
      mod.rs
      auth.rs         # Clerk dev-instance sign-in + token refresh
      api.rs          # /project/user, /project/info, /project/status/...,
                      # /commit/by-id, /store/download
      plan.rs         # builds the in-memory import plan (8.6.2)
    helios/
      mod.rs          # thin wrapper over pdm-client + service-role flavor
      service_role.rs # ClientBuilder.service_role(jwt) -> sets Authorization
      import.rs       # pdm_import_version RPC call
      storage_admin.rs# upload via PUT /storage/v1/object/{bucket}/{path}
    pipeline.rs       # the per-file algorithm in 8.7
    progress.rs       # indicatif progress bars + JSONL run log
    verify.rs         # post-import sanity (counts, sample sha2 re-check)
```

New deps not in workspace today: `flate2`, `hex`, `indicatif`, `tracing`, `tracing-subscriber`, `tempfile`, `futures-util` (stream concat).

Notably *not* needed: `sqlx`, `aws-sdk-s3`, `aws-config`. Big simplification — no DB driver, no AWS SDK, just `reqwest`.

A small change to `pdm-client/src/client.rs`: add a `service_role` builder mode that takes the service-role JWT and sets it as both the `apikey` and `Authorization: Bearer`, skipping `sign_in`. This is the one cross-cutting change to Helios's existing crate — kept minimal and behind a `service_role` feature flag.

### 8.9 Run modes

- `glassypdm-import dry-run --source-project N --target-vault SDM26`
  Walks the metadata queries and prints: file count, total bytes, dedupe ratio (`select count(distinct filehash)`), and the first 20 paths. No S3, no writes.

- `glassypdm-import import --source-project N --target-vault SDM26 [--resume]`
  Real run. Writes a JSONL log to `glassypdm-import.{timestamp}.jsonl`, one line per file with `{path, sha, bytes, status, ms}`. `--resume` reads the log if present and skips files marked `done`.

- `glassypdm-import verify --target-vault SDM26 --sample 50`
  Picks 50 random `pdm.versions` rows in the target vault, downloads the gzipped blob, decompresses, re-hashes, and compares against the row's `sha256`. Fails loudly if any mismatch.

### 8.10 Edge cases the importer must handle

- **Path locations preserved verbatim.** The Helios folder hierarchy mirrors glassyPDM 1:1. `Suspension\CAD\Solidworks\Models\ARBs\Rears\26-07-MS-ARB-Bearing Cup 1.SLDPRT` becomes folders `[Suspension, CAD, Solidworks, Models, ARBs, Rears]` with file `26-07-MS-ARB-Bearing Cup 1.SLDPRT` — folder *names* and file *name* are byte-identical to glassyPDM. The only transformation is `\` → `/` for splitting; nothing else. Typo'd directory names (`Manfacturing`, `Asembly`) are preserved as-is because that's how the team's data exists.
- **File contents byte-identical.** Helios gzip-wraps the blob for storage, but the bytes inside the gzip are exactly the bytes returned from glassyPDM's S3, and `import_metadata.source_filehash_blake3` lets anyone independently verify against the original.
- **Path with empty segments** (`Chassis\\Subframe\x`): collapse runs of separators before splitting.
- **Path at root** (no separator): `folder_id = NULL`.
- **Path with leading separator** or `.\`: strip before splitting.
- **Zero-byte files**: empirically SDM-26 has none. If they show up, log and skip — the upload path doesn't gracefully handle empty blobs.
- **File name uniqueness collision** in the target vault: glassyPDM allows `(projectid, path)` uniqueness, Helios enforces `(folder_id, name)` uniqueness via `files_folder_id_name_key`. If the source has the same path twice under different casing, the importer logs the collision and aborts with a clear error rather than guessing.
- **Folder race**: two parallel imports adding files into the same new deep folder. The importer's `ensure_folder_hierarchy` uses the same lookup → insert → on-unique-violation re-query pattern as `useAddLocalFile.ts:65-87`.
- **S3 transient errors**: retry per chunk with exponential backoff (3 attempts, 200ms → 2s).
- **Presigned URL expiry**: each `/store/download` response is good for 48 hours. The importer doesn't cache URLs across resumes — every retry re-requests fresh URLs.
- **Clerk JWT expiry mid-run**: tokens last ~60 minutes. The importer refreshes proactively at the 50-minute mark; if a request 401s, it refreshes once and retries.
- **Connection drops mid-file**: the temp file is discarded, the run-log line is `error`, `--resume` retries it next run.

#### 8.10.1 Empirical SDM-26 budget (probe 2026-05-24)

| Metric | Value |
|---|---|
| Total filerevision rows at HEAD | 5,530 |
| Live files to import | 4,451 |
| Skipped (`changetype == 3`) | 1,079 |
| Unique filehashes | 4,202 (94% — modest dedupe) |
| Total uncompressed bytes | 8.34 GiB |
| Largest single file | 256 MB (`Asembly/sdm26rev2/3-view/SDM26-3-VIEW.SLDDRW`) |
| Project history depth | 967 commits over ~22 months |

Top-level layout: `Suspension/` 5.00 GiB (2,192 files), `Systems/` 1.05 GiB, `MOTEC/` 0.82 GiB, `Aero/`, `Chassis/`, `Engine/`, `Drivetrain/`, `DAQ/`, `Brakes/`, `Manfacturing/`, `Asembly/`, plus a handful of files at project root. Extensions skew binary: `.sldprt/.sldasm/.slddrw` (already-compressed), `.mat` (compresses well), `.ld` (binary), `.csv`, `.step`, `.stl`, `.pdf`.

At a conservative 10 MB/s end-to-end throughput, the migration is ~15 minutes single-threaded, ~5 minutes with 4–6 parallel files. Peak local disk during a run is ~256 MB (one large file).

### 8.11 Security

Two credentials in play, both kept out of chat history and the repo:

1. **glassyPDM login** (email + Clerk password). Read from `~/glassypdm-creds.txt` (file mode `600`, located outside the Helios repo). The importer never writes the password back, never logs it, redacts it from any header dumps. The Clerk session JWT it derives is held in memory only.
2. **Supabase service-role key.** Read from `~/helios-service-role.txt` (same convention, file mode `600`, outside the repo). Service role is the most powerful credential in Helios — the importer is the only consumer. It's never passed as a CLI flag (where it would land in shell history) and never written to the run log.

After import, the run log contains paths, SHAs, file IDs, and per-file timings. No credentials, no presigned S3 URLs (those would let a leak download blobs for 48 hours).

### 8.12 Historical versions

V1 of the import does **current only** — for each glassypdm file, take its latest `filerevision` and import that as `pdm.versions` v1. Helios then continues history from there.

A future "full history" mode (not in initial scope) would walk every `filerevision` in `commitid` order and call `pdm_import_version` once per revision, preserving the version chain via the existing `parent_version_id` column on `pdm.versions`. Cheap to add later because the RPC is already designed for it.

### 8.13 User authorship

glassyPDM `userid` is a Clerk string id and doesn't map onto Supabase auth users. The import uses `p_author_id = null` for all imported versions and sets the comment to `"[imported from glassyPDM] {original comment} — by {original userid}"` so the audit trail survives.

### 8.14 Where to run the tool

Either:
- **Locally on the user's laptop** with VPN access to the glassypdm DB + S3. Streaming bounds disk usage; only network egress is real (full dataset transits the laptop once). Easy to babysit.
- **On a small cloud VM** in the same region as either glassyPDM's S3 or Supabase Storage. Cheaper egress, faster, runs unattended.

Recommendation: run locally first for the first project (visibility + iteration), move to a VM only if SDM26 is too big to run through a home connection in one sitting.

## 9. Phasing

The work splits naturally:

**Phase A — Client multi-vault (no schema changes):**
1. `useActiveVault` hook + NavRail switcher.
2. Per-vault `useVaultFolder` map.
3. Replace `vaults?.[0]` at the two call sites.
4. Promote vault creation from BrowseScreen empty-state into the switcher + Settings.

Ships immediately. Lets the user create an empty SDM26 vault and switch between SDM27 / SDM26 in the UI.

**Phase B — Per-vault roles:**
5. `pdm.vault_roles` migration + backfill with dual-policy safeguards from §6.5.
6. `pdm.user_role_for_vault()` function and RLS update.
7. `useMyRoleFor` hook + rename/delete/role-grant RPCs.
8. Settings → Vault management list + per-vault roster + Users list.

**Phase C — glassyPDM → SDM26 import:**
9. `pdm_import_version` RPC.
10. `crates/glassypdm-import` standalone CLI.
11. Dry-run + resume + idempotent re-runs.
12. Execute migration; verify file counts and a sample of sha256s.

Phase C depends on Phase A (the SDM26 vault must exist as a real selectable vault) but not on Phase B (the importer runs as service-role and bypasses RLS). If the timeline is tight, Phase B can be deferred.

## 10. Open questions

None blocking. The user has explicitly endorsed per-role gating for management UIs (enforced via `useIsAdmin()` for create/rename/delete and `useMyRoleFor(vaultId)` for edit/checkout), and confirmed glassyPDM credentials are available for Phase C.
