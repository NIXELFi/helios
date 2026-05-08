# Helios Vault — Plan 1: Backend Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Supabase Postgres schema, RLS policies, and RPCs that will back Helios Vault. After this plan, an admin can create a vault, an editor can acquire and release a lock, a non-holder cannot insert a version, and an admin can force-unlock — all verifiable by SQL or `supabase-js` against a local Supabase instance.

**Architecture:** Supabase CLI manages a local Postgres instance for development; production is a Supabase Pro project. SQL migrations live under `infra/pdm-supabase/supabase/migrations/` (the standard CLI layout). RLS is the only authorization layer for direct table access; mutations that need transaction-level invariants go through `security definer` Postgres RPCs. Integration tests run with Vitest using `@supabase/supabase-js`, exercising real RLS and RPC behavior against the local instance — no mocking.

**Tech Stack:** PostgreSQL 15 (via Supabase), Supabase CLI 1.x, `@supabase/supabase-js` v2, Vitest, TypeScript, dotenv. No Rust in this plan (the Rust crates land in Plan 2).

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)

---

## File Structure

### New files

```
infra/pdm-supabase/
  README.md                                       ← run instructions, deploy steps
  package.json                                    ← @supabase/supabase-js, vitest, dotenv
  tsconfig.json
  vitest.config.ts
  .env.example                                    ← SUPABASE_URL / KEY shape
  .gitignore                                      ← .env, supabase/.branches/, supabase/.temp/
  supabase/
    config.toml                                   ← Supabase CLI local config
    migrations/
      20260507000000_pdm_schema.sql               ← schema + tables + indexes
      20260507000100_pdm_user_roles.sql           ← user_roles + helper fn pdm.is_admin()
      20260507000200_pdm_rls_structure.sql        ← RLS for vaults/folders/files
      20260507000300_pdm_rls_locks.sql            ← RLS for locks
      20260507000400_pdm_rls_versions.sql         ← RLS for versions + refs
      20260507000500_pdm_rpc_check_in.sql         ← pdm.check_in()
      20260507000600_pdm_rpc_force_unlock.sql     ← pdm.force_unlock()
      20260507000700_pdm_rpc_cancel_checkout.sql  ← pdm.cancel_checkout()
      20260507000800_pdm_storage.sql              ← vault-objects bucket + RLS
      20260507000900_pdm_audit_triggers.sql       ← audit-log auto-write triggers
  tests/
    setup.ts                                      ← Supabase clients, test-user helpers
    schema.test.ts                                ← table existence sanity check
    rls-roles.test.ts                             ← user_roles + is_admin()
    rls-structure.test.ts                         ← admin-only structure mutations
    rls-locks.test.ts                             ← lock acquire/release rules
    rls-versions.test.ts                          ← version insert requires lock
    rpc-check-in.test.ts                          ← check_in atomic behavior
    rpc-force-unlock.test.ts                      ← force_unlock admin gate
    rpc-cancel-checkout.test.ts                   ← cancel_checkout
    storage.test.ts                               ← signed URL upload/download
    audit-log.test.ts                             ← every state change audited
  scripts/
    bootstrap-admin.ts                            ← one-shot: promote first admin
```

### Modified files

```
pnpm-workspace.yaml                               ← add "infra/*" glob
.gitignore                                        ← add infra/pdm-supabase/.env
```

### Files NOT touched

The Tauri desktop app, the existing crates (`helios-arrow`, `helios-core`, `helios-csv`), the React frontend, and any v2_changes write-ups. This plan is server-side only.

---

## Prerequisites (one-time, on the developer machine)

1. **Supabase CLI installed.**

   ```bash
   brew install supabase/tap/supabase
   supabase --version   # should print 1.x or later
   ```

2. **Docker Desktop running.** The Supabase CLI runs Postgres + GoTrue + PostgREST + Realtime + Storage in containers locally.

3. **Node 20+ and pnpm 9** — already required by Helios.

---

## Conventions used throughout

- **TDD cycle per task:** failing test → run-and-confirm-fail → migration / SQL change → run-and-confirm-pass → commit. SQL migrations are append-only after they've been applied; if a migration is wrong before commit, edit it; once committed, write a *new* migration to fix.
- **Two Supabase JS clients per test file:** `serviceClient` (uses `SUPABASE_SERVICE_ROLE_KEY`, bypasses RLS — used for test setup/teardown) and `userClient(user)` factory (uses `SUPABASE_ANON_KEY` + a per-user JWT — exercises real RLS).
- **No `git push`.** Every step in this plan ends in a local commit. Pushing to a remote happens only after Plan 4 lands at the earliest, per the roadmap.
- **One commit per TDD cycle.** The commit message format mirrors the existing Helios convention (`feat(scope): subject`, `test(scope): subject`, `docs(scope): subject`).
- **Migration filenames are timestamp-prefixed** to keep ordering deterministic. The Supabase CLI applies them in lexicographic order. The numbers in this plan (`20260507000000`, `…000100`, `…000200`, …) leave room to insert future migrations.
- **All migrations are idempotent at apply time.** `supabase db reset` drops and recreates the database from migrations, so non-idempotent statements are fine — but use `if not exists` where it costs nothing.

---

## Task 0: Scaffold `infra/pdm-supabase/`

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `.gitignore`
- Create: `infra/pdm-supabase/package.json`
- Create: `infra/pdm-supabase/tsconfig.json`
- Create: `infra/pdm-supabase/vitest.config.ts`
- Create: `infra/pdm-supabase/.env.example`
- Create: `infra/pdm-supabase/.gitignore`
- Create: `infra/pdm-supabase/README.md`

- [ ] **Step 1: Add `infra/*` to pnpm workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "infra/*"
```

- [ ] **Step 2: Add `infra/pdm-supabase/.env` to root .gitignore**

Append to `.gitignore`:

```
# Supabase local secrets
infra/pdm-supabase/.env
```

- [ ] **Step 3: Create `infra/pdm-supabase/package.json`**

```json
{
  "name": "@helios/pdm-supabase",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "db:start": "supabase start",
    "db:stop": "supabase stop",
    "db:reset": "supabase db reset",
    "db:status": "supabase status",
    "test": "vitest run",
    "test:watch": "vitest",
    "bootstrap:admin": "tsx scripts/bootstrap-admin.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "tsx": "^4.19.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 4: Create `infra/pdm-supabase/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["tests/**/*", "scripts/**/*"]
}
```

- [ ] **Step 5: Create `infra/pdm-supabase/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 30_000,
    fileParallel: false,
    sequence: { concurrent: false },
  },
});
```

(The `fileParallel: false` and non-concurrent sequence matter: the tests share a database, so running them in parallel would cause cross-test interference.)

- [ ] **Step 6: Create `infra/pdm-supabase/.env.example`**

```
# Local Supabase (printed by `supabase status` after `supabase start`)
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

- [ ] **Step 7: Create `infra/pdm-supabase/.gitignore`**

```
node_modules
.env
supabase/.branches/
supabase/.temp/
supabase/seed.sql
```

- [ ] **Step 8: Create `infra/pdm-supabase/README.md`**

```markdown
# @helios/pdm-supabase

Supabase project that backs the Helios Vault module. Holds the `pdm` schema migrations, RLS policies, RPCs, storage bucket config, and integration tests.

## Local development

1. Install Supabase CLI: `brew install supabase/tap/supabase`.
2. Start Docker Desktop.
3. From this directory: `pnpm db:start`. First run takes ~2 minutes.
4. Print local credentials: `pnpm db:status`. Copy the `anon key` and `service_role key` into `.env` (use `.env.example` as a template).
5. Run integration tests: `pnpm test`.
6. Reset the database (re-applies all migrations from scratch): `pnpm db:reset`.
7. Stop the local stack: `pnpm db:stop`.

## Production deploy

1. `supabase link --project-ref <ref>` against the live project.
2. `supabase db push` to apply migrations.
3. Run `pnpm bootstrap:admin -- --email <email>` once to create the first admin.

The bootstrap script is the only one-shot procedure; everything else is migration-driven.

## Layout

| Path | Purpose |
| --- | --- |
| `supabase/migrations/` | Append-only SQL migrations |
| `supabase/config.toml` | Supabase CLI local config |
| `tests/` | Vitest integration tests against the local Supabase |
| `scripts/bootstrap-admin.ts` | One-shot admin promoter |
```

- [ ] **Step 9: Initialize the Supabase CLI project**

```bash
cd infra/pdm-supabase
supabase init --workdir .
```

This creates `supabase/config.toml` and an empty `supabase/migrations/` directory. Confirm:

```bash
ls supabase/   # should show config.toml, migrations/, .gitignore (CLI-generated)
```

- [ ] **Step 10: Install workspace deps and verify Supabase boots**

From repo root:

```bash
pnpm install
cd infra/pdm-supabase
pnpm db:start      # ~2 minutes first time
pnpm db:status     # prints API URL + keys
pnpm db:stop       # leave it stopped between tasks unless tests are running
```

Expected: `pnpm db:status` prints lines starting with `API URL:`, `anon key:`, and `service_role key:`. Copy those into `.env`.

- [ ] **Step 11: Commit**

```bash
git add pnpm-workspace.yaml .gitignore infra/pdm-supabase
git commit -m "infra(pdm-supabase): scaffold Supabase project for Helios Vault backend"
```

---

## Task 1: Schema migration — `pdm` tables

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000000_pdm_schema.sql`
- Create: `infra/pdm-supabase/tests/setup.ts`
- Create: `infra/pdm-supabase/tests/schema.test.ts`

- [ ] **Step 1: Create the test setup file**

`infra/pdm-supabase/tests/setup.ts`:

```ts
import { config } from "dotenv";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

config();

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    "Missing SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY. Run `pnpm db:status` and copy values into .env.",
  );
}

export const serviceClient = (): SupabaseClient =>
  createClient(url, serviceKey, { auth: { persistSession: false } });

export const anonClient = (): SupabaseClient =>
  createClient(url, anonKey, { auth: { persistSession: false } });

/** Creates a confirmed test user via the admin API and returns the User row. */
export async function createTestUser(
  email: string,
  password = "test-password-123",
): Promise<User> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!;
}

/** Returns a Supabase client signed in as the given user. */
export async function signInAs(
  email: string,
  password = "test-password-123",
): Promise<SupabaseClient> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

/** Sets a user's pdm role. Bypasses RLS via service role. */
export async function setRole(
  userId: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.from("user_roles").upsert(
    { user_id: userId, role },
    { onConflict: "user_id" },
  ).select().single();
  if (error) throw error;
}

/** Wipes all pdm data (but keeps schema + auth users). Run between tests. */
export async function resetPdmTables(): Promise<void> {
  const svc = serviceClient();
  // Delete in FK-safe order. RPC wraps in a transaction.
  const { error } = await svc.rpc("pdm_test_reset");
  if (error && !error.message.includes("does not exist")) throw error;
}

/** Deletes every auth user (and cascades to user_roles). */
export async function resetAuthUsers(): Promise<void> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.listUsers();
  if (error) throw error;
  for (const u of data.users) {
    await svc.auth.admin.deleteUser(u.id);
  }
}

/** Returns a unique email per test to avoid cross-test collisions. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@helios.test`;
}
```

(The `pdm_test_reset` RPC referenced above doesn't exist yet — that's fine; the helper guards against the "does not exist" error. We'll add the RPC later in Task 11; until then, individual tests will create their own data with unique IDs and not rely on global reset.)

- [ ] **Step 2: Write the failing schema test**

`infra/pdm-supabase/tests/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serviceClient } from "./setup.js";

describe("pdm schema", () => {
  it("has all expected tables", async () => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("information_schema.tables")
      .select("table_name")
      .eq("table_schema", "pdm");
    expect(error).toBeNull();
    const names = (data ?? []).map((r: any) => r.table_name).sort();
    expect(names).toEqual([
      "audit_log",
      "files",
      "folders",
      "locks",
      "refs",
      "user_roles",
      "vaults",
      "versions",
    ]);
  });

  it("locks table has unique-active-lock-per-file index", async () => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("pg_indexes")
      .select("indexname")
      .eq("schemaname", "pdm")
      .eq("tablename", "locks");
    expect(error).toBeNull();
    const names = (data ?? []).map((r: any) => r.indexname);
    expect(names).toContain("one_active_lock_per_file");
  });
});
```

- [ ] **Step 3: Run the test and confirm failure**

```bash
cd infra/pdm-supabase
pnpm db:start    # if not already running
pnpm test schema.test.ts
```

Expected: both tests fail because the `pdm` schema doesn't exist yet (or the assertion arrays are empty).

- [ ] **Step 4: Write the schema migration**

`infra/pdm-supabase/supabase/migrations/20260507000000_pdm_schema.sql`:

```sql
-- Helios Vault — Phase 1 schema
-- Spec: docs/superpowers/specs/2026-05-07-helios-vault-design.md

create schema if not exists pdm;

-- Vaults: top-level containers. Phase 1 has exactly one row.
create table pdm.vaults (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

-- Folder tree inside a vault.
create table pdm.folders (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references pdm.vaults(id) on delete cascade,
  parent_id uuid references pdm.folders(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (vault_id, parent_id, name)
);

-- Logical file. Versions hang off this; latest_version_id is a denormalized
-- pointer to the current version for fast browse queries.
create table pdm.files (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references pdm.vaults(id) on delete cascade,
  folder_id uuid references pdm.folders(id) on delete cascade,
  name text not null,
  latest_version_id uuid,                         -- FK added below after versions exists
  created_at timestamptz not null default now(),
  unique (folder_id, name)
);

-- Immutable versions, content-addressed via sha256.
create table pdm.versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references pdm.files(id) on delete cascade,
  version_num int not null,
  sha256 text not null,
  size_bytes bigint not null,
  author_id uuid not null references auth.users(id),
  comment text,
  parent_version_id uuid references pdm.versions(id),
  created_at timestamptz not null default now(),
  unique (file_id, version_num)
);

alter table pdm.files
  add constraint files_latest_version_fk
  foreign key (latest_version_id) references pdm.versions(id) on delete set null;

-- Locks: at most one active per file.
create table pdm.locks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references pdm.files(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  acquired_at timestamptz not null default now(),
  released_at timestamptz,
  force_released_by uuid references auth.users(id)
);
create unique index one_active_lock_per_file
  on pdm.locks(file_id) where released_at is null;
create index locks_active_by_user
  on pdm.locks(user_id) where released_at is null;

-- Parent → child references parsed from .sldasm/.sldprt by the edge function.
create table pdm.refs (
  parent_version_id uuid not null references pdm.versions(id) on delete cascade,
  child_path_hint text not null,
  child_file_id uuid references pdm.files(id) on delete set null,
  primary key (parent_version_id, child_path_hint)
);
create index refs_by_child on pdm.refs(child_file_id) where child_file_id is not null;

-- Audit log: every state-changing op.
create table pdm.audit_log (
  id bigserial primary key,
  user_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id uuid not null,
  payload jsonb,
  ts timestamptz not null default now()
);
create index audit_log_target on pdm.audit_log(target_type, target_id, ts desc);

-- Roles. Stored as a separate table so RLS policies can reference role with a
-- JOIN rather than parsing JSON in raw_user_meta_data.
create table pdm.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id)
);

-- We expose the pdm schema to PostgREST so the JS client can hit pdm.* tables.
grant usage on schema pdm to anon, authenticated, service_role;
grant all on all tables in schema pdm to service_role;
grant select on all tables in schema pdm to authenticated;
alter default privileges in schema pdm grant select on tables to authenticated;
alter default privileges in schema pdm grant all on tables to service_role;
```

Append `pdm` to the exposed schemas list in `infra/pdm-supabase/supabase/config.toml`. Find the `[api]` section and ensure it reads:

```toml
[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public", "pdm"]
extra_search_path = ["public", "extensions", "pdm"]
max_rows = 1000
```

(If `[api]` isn't already configured this way, edit it; the default `schemas` array does not include `pdm`.)

- [ ] **Step 5: Apply the migration and re-run the test**

```bash
cd infra/pdm-supabase
pnpm db:reset
pnpm test schema.test.ts
```

Expected: both tests pass. The information_schema query returns the eight tables; the pg_indexes query includes `one_active_lock_per_file`.

- [ ] **Step 6: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000000_pdm_schema.sql \
        infra/pdm-supabase/supabase/config.toml \
        infra/pdm-supabase/tests/setup.ts \
        infra/pdm-supabase/tests/schema.test.ts
git commit -m "feat(pdm): add Helios Vault schema (vaults, folders, files, versions, locks, refs, audit_log, user_roles)"
```

---

## Task 2: `pdm.user_roles` + `pdm.is_admin()` helper + roles RLS

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000100_pdm_user_roles.sql`
- Create: `infra/pdm-supabase/tests/rls-roles.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rls-roles.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("user_roles RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("authenticated users can read their own role", async () => {
    const email = uniqueEmail("editor");
    const u = await createTestUser(email);
    await setRole(u.id, "editor");

    const c = await signInAs(email);
    const { data, error } = await c.from("user_roles").select("role").eq("user_id", u.id).single();
    expect(error).toBeNull();
    expect(data?.role).toBe("editor");
  });

  it("a non-admin cannot insert into user_roles", async () => {
    const email = uniqueEmail("editor");
    const u = await createTestUser(email);
    await setRole(u.id, "editor");
    const c = await signInAs(email);

    const target = await createTestUser(uniqueEmail("target"));
    const { error } = await c.from("user_roles").insert({ user_id: target.id, role: "editor" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // permission denied
  });

  it("an admin can insert into user_roles", async () => {
    const email = uniqueEmail("admin");
    const u = await createTestUser(email);
    await setRole(u.id, "admin");
    const c = await signInAs(email);

    const target = await createTestUser(uniqueEmail("target"));
    const { error } = await c.from("user_roles").insert({ user_id: target.id, role: "viewer" });
    expect(error).toBeNull();
  });

  it("pdm.is_admin() returns true for admins, false for editors", async () => {
    const adminEmail = uniqueEmail("admin");
    const a = await createTestUser(adminEmail);
    await setRole(a.id, "admin");
    const ac = await signInAs(adminEmail);
    const { data: aRes } = await ac.rpc("pdm_is_admin");
    expect(aRes).toBe(true);

    const editorEmail = uniqueEmail("editor");
    const e = await createTestUser(editorEmail);
    await setRole(e.id, "editor");
    const ec = await signInAs(editorEmail);
    const { data: eRes } = await ec.rpc("pdm_is_admin");
    expect(eRes).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rls-roles.test.ts
```

Expected: failures because RLS isn't enabled on `pdm.user_roles` and `pdm_is_admin` doesn't exist. The "non-admin cannot insert" test will currently *pass* by accident (with the default `select`-only grant for `authenticated`, the insert will fail, but with a different error). We need RLS on for proper enforcement.

- [ ] **Step 3: Add the RLS migration and helper function**

`infra/pdm-supabase/supabase/migrations/20260507000100_pdm_user_roles.sql`:

```sql
-- Helper: is the calling user a pdm admin?
create or replace function pdm.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- Expose as a top-level callable RPC for tests / clients (PostgREST exposes
-- public-schema functions; we proxy to pdm.is_admin()).
create or replace function public.pdm_is_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$ select pdm.is_admin(); $$;

grant execute on function public.pdm_is_admin() to authenticated;

-- RLS for pdm.user_roles
alter table pdm.user_roles enable row level security;

-- Read: any authenticated user can read every row (single-team app).
create policy user_roles_read on pdm.user_roles
  for select to authenticated
  using (true);

-- Insert / update / delete: admin only.
create policy user_roles_insert_admin on pdm.user_roles
  for insert to authenticated
  with check (pdm.is_admin());

create policy user_roles_update_admin on pdm.user_roles
  for update to authenticated
  using (pdm.is_admin())
  with check (pdm.is_admin());

create policy user_roles_delete_admin on pdm.user_roles
  for delete to authenticated
  using (pdm.is_admin());
```

- [ ] **Step 4: Re-apply migrations and re-run the test**

```bash
pnpm db:reset
pnpm test rls-roles.test.ts
```

Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000100_pdm_user_roles.sql \
        infra/pdm-supabase/tests/rls-roles.test.ts
git commit -m "feat(pdm): add user_roles RLS + pdm.is_admin() helper"
```

---

## Task 3: RLS for `vaults`, `folders`, `files` (admin-only mutations)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000200_pdm_rls_structure.sql`
- Create: `infra/pdm-supabase/tests/rls-structure.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rls-structure.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("vaults / folders / files RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor can read vaults but not insert", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    // Admin creates a vault via service client (bypassing RLS) — simulating a prior admin op.
    const svc = serviceClient();
    const { data: vault, error: vErr } = await svc
      .from("vaults")
      .insert({ name: "test-vault", created_by: admin.id })
      .select()
      .single();
    expect(vErr).toBeNull();

    const eClient = await signInAs(editor.email!);
    const { data: rows, error: readErr } = await eClient.from("vaults").select("*");
    expect(readErr).toBeNull();
    expect(rows?.length).toBe(1);

    const { error: insErr } = await eClient.from("vaults").insert({
      name: "editor-vault",
      created_by: editor.id,
    });
    expect(insErr).not.toBeNull();
    expect(insErr?.code).toBe("42501");
  });

  it("admin can create vaults, folders, and files", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const c = await signInAs(admin.email!);

    const { data: vault, error: vErr } = await c
      .from("vaults")
      .insert({ name: "vault-1", created_by: admin.id })
      .select()
      .single();
    expect(vErr).toBeNull();

    const { data: folder, error: fErr } = await c
      .from("folders")
      .insert({ vault_id: vault!.id, name: "parts" })
      .select()
      .single();
    expect(fErr).toBeNull();

    const { error: fileErr } = await c
      .from("files")
      .insert({ vault_id: vault!.id, folder_id: folder!.id, name: "frame.sldprt" });
    expect(fileErr).toBeNull();
  });

  it("editor cannot insert folders or files", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const svc = serviceClient();
    const { data: vault } = await svc
      .from("vaults")
      .insert({ name: "vault-2", created_by: admin.id })
      .select()
      .single();

    const eClient = await signInAs(editor.email!);
    const { error: folderErr } = await eClient
      .from("folders")
      .insert({ vault_id: vault!.id, name: "should-fail" });
    expect(folderErr?.code).toBe("42501");

    const { error: fileErr } = await eClient
      .from("files")
      .insert({ vault_id: vault!.id, name: "should-fail.sldprt" });
    expect(fileErr?.code).toBe("42501");
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rls-structure.test.ts
```

Expected: failures because RLS is not enabled — the editor will be able to insert (default permission granted in the schema migration).

- [ ] **Step 3: Add the structure RLS migration**

`infra/pdm-supabase/supabase/migrations/20260507000200_pdm_rls_structure.sql`:

```sql
-- Vaults
alter table pdm.vaults enable row level security;
create policy vaults_read on pdm.vaults
  for select to authenticated using (true);
create policy vaults_insert_admin on pdm.vaults
  for insert to authenticated with check (pdm.is_admin());
create policy vaults_update_admin on pdm.vaults
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy vaults_delete_admin on pdm.vaults
  for delete to authenticated using (pdm.is_admin());

-- Folders
alter table pdm.folders enable row level security;
create policy folders_read on pdm.folders
  for select to authenticated using (true);
create policy folders_insert_admin on pdm.folders
  for insert to authenticated with check (pdm.is_admin());
create policy folders_update_admin on pdm.folders
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy folders_delete_admin on pdm.folders
  for delete to authenticated using (pdm.is_admin());

-- Files
alter table pdm.files enable row level security;
create policy files_read on pdm.files
  for select to authenticated using (true);
create policy files_insert_admin on pdm.files
  for insert to authenticated with check (pdm.is_admin());
create policy files_update_admin on pdm.files
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy files_delete_admin on pdm.files
  for delete to authenticated using (pdm.is_admin());
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rls-structure.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000200_pdm_rls_structure.sql \
        infra/pdm-supabase/tests/rls-structure.test.ts
git commit -m "feat(pdm): RLS — admin-only mutations on vaults/folders/files"
```

---

## Task 4: RLS for `locks` (acquire by editor; release by self or admin)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000300_pdm_rls_locks.sql`
- Create: `infra/pdm-supabase/tests/rls-locks.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rls-locks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";
import type { SupabaseClient } from "@supabase/supabase-js";

async function seedVaultAndFile(adminId: string): Promise<{ fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}`, created_by: adminId })
    .select()
    .single();
  const { data: f } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "parts" })
    .select()
    .single();
  const { data: file } = await svc
    .from("files")
    .insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" })
    .select()
    .single();
  return { fileId: file!.id };
}

describe("locks RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor can acquire a lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data, error } = await c
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(editor.id);
  });

  it("viewer cannot acquire a lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(viewer.email!);
    const { error } = await c.from("locks").insert({ file_id: fileId, user_id: viewer.id });
    expect(error?.code).toBe("42501");
  });

  it("two editors cannot hold an active lock on the same file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { error: aErr } = await aClient.from("locks").insert({ file_id: fileId, user_id: a.id });
    expect(aErr).toBeNull();

    const bClient = await signInAs(b.email!);
    const { error: bErr } = await bClient.from("locks").insert({ file_id: fileId, user_id: b.id });
    expect(bErr).not.toBeNull();
    expect(bErr?.code).toBe("23505"); // unique_violation
  });

  it("editor can release their own lock by updating released_at", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data: lock } = await c
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    const { error } = await c
      .from("locks")
      .update({ released_at: new Date().toISOString() })
      .eq("id", lock!.id);
    expect(error).toBeNull();
  });

  it("editor cannot release another editor's lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { data: lock } = await aClient
      .from("locks")
      .insert({ file_id: fileId, user_id: a.id })
      .select()
      .single();

    const bClient = await signInAs(b.email!);
    const { data, error } = await bClient
      .from("locks")
      .update({ released_at: new Date().toISOString() })
      .eq("id", lock!.id)
      .select();
    // RLS: update silently affects 0 rows when the using clause excludes the row.
    expect(error).toBeNull();
    expect(data?.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rls-locks.test.ts
```

Expected: failures — RLS is not yet enabled on `pdm.locks`.

- [ ] **Step 3: Add the locks RLS migration**

`infra/pdm-supabase/supabase/migrations/20260507000300_pdm_rls_locks.sql`:

```sql
alter table pdm.locks enable row level security;

-- Read: any authenticated user.
create policy locks_read on pdm.locks
  for select to authenticated using (true);

-- Insert: editors and admins. The user_id must equal the caller; clients can't
-- create a lock on someone else's behalf.
create policy locks_insert on pdm.locks
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('admin', 'editor')
    )
  );

-- Update (release): the caller must be the lock holder OR an admin (force-release).
-- Note: real release/force-release should go through pdm.cancel_checkout /
-- pdm.force_unlock RPCs, but allowing direct UPDATE keeps integration tests
-- straightforward and is harmless because the caller still must satisfy this rule.
create policy locks_update_self_or_admin on pdm.locks
  for update to authenticated
  using (user_id = auth.uid() or pdm.is_admin())
  with check (user_id = auth.uid() or pdm.is_admin());

-- No delete policy: rows are never deleted, only updated to set released_at.
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rls-locks.test.ts
```

Expected: all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000300_pdm_rls_locks.sql \
        infra/pdm-supabase/tests/rls-locks.test.ts
git commit -m "feat(pdm): RLS — locks (acquire by editor; release by self or admin)"
```

---

## Task 5: RLS for `versions` and `refs` (insert version requires holding lock)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000400_pdm_rls_versions.sql`
- Create: `infra/pdm-supabase/tests/rls-versions.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rls-versions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedVaultAndFile(adminId: string): Promise<{ fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc
    .from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc
    .from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return { fileId: file!.id };
}

describe("versions RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor without lock cannot insert a version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("editor holding the lock can insert a version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error).toBeNull();
  });

  it("editor whose lock is released cannot insert a version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data: lock } = await c
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    await c.from("locks").update({ released_at: new Date().toISOString() }).eq("id", lock!.id);

    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error?.code).toBe("42501");
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rls-versions.test.ts
```

Expected: failures because RLS isn't enabled on `pdm.versions` yet.

- [ ] **Step 3: Add the versions/refs RLS migration**

`infra/pdm-supabase/supabase/migrations/20260507000400_pdm_rls_versions.sql`:

```sql
-- Versions
alter table pdm.versions enable row level security;

create policy versions_read on pdm.versions
  for select to authenticated using (true);

-- Insert: caller must hold the active lock on the file AND be the author.
create policy versions_insert_lockholder on pdm.versions
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from pdm.locks
      where locks.file_id = versions.file_id
        and locks.user_id = auth.uid()
        and locks.released_at is null
    )
  );

-- Update / delete: nobody (admin can use service role for emergencies, but
-- versions are immutable in normal operation).
-- (No update/delete policies = no rows pass the using clause = denied.)

-- Refs
alter table pdm.refs enable row level security;

create policy refs_read on pdm.refs
  for select to authenticated using (true);

-- Insert / update / delete: nobody from the client. The parse-refs edge function
-- uses the service role to populate this table.
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rls-versions.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000400_pdm_rls_versions.sql \
        infra/pdm-supabase/tests/rls-versions.test.ts
git commit -m "feat(pdm): RLS — versions insert requires holding active lock; refs server-only"
```

---

## Task 6: RPC `pdm.check_in()`

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000500_pdm_rpc_check_in.sql`
- Create: `infra/pdm-supabase/tests/rpc-check-in.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rpc-check-in.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedVaultAndFile(adminId: string): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc
    .from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc
    .from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return { vaultId: v!.id, fileId: file!.id };
}

describe("pdm.check_in()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("inserts a version, releases the lock, updates files.latest_version_id, all atomically", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const sha = "a".repeat(64);
    const { data, error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId,
      p_sha256: sha,
      p_size: 1234,
      p_comment: "first cut",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ file_id: fileId, version_num: 1, sha256: sha, size_bytes: 1234 });

    const svc = serviceClient();
    const { data: file } = await svc.from("files").select("latest_version_id").eq("id", fileId).single();
    expect(file!.latest_version_id).toBe(data.id);

    const { data: locks } = await svc.from("locks").select("released_at").eq("file_id", fileId);
    expect(locks!.every((l) => l.released_at !== null)).toBe(true);
  });

  it("increments version_num on each subsequent check-in", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);
    const c = await signInAs(editor.email!);

    for (let i = 1; i <= 3; i++) {
      await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
      const { data, error } = await c.rpc("pdm_check_in", {
        p_file_id: fileId,
        p_sha256: String(i).padStart(64, "0"),
        p_size: i,
        p_comment: `v${i}`,
      });
      expect(error).toBeNull();
      expect(data.version_num).toBe(i);
    }
  });

  it("rejects check-in if the caller doesn't hold the lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId,
      p_sha256: "a".repeat(64),
      p_size: 1,
      p_comment: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no active lock/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rpc-check-in.test.ts
```

Expected: failures because `pdm_check_in` doesn't exist (`function … does not exist`).

- [ ] **Step 3: Add the RPC migration**

`infra/pdm-supabase/supabase/migrations/20260507000500_pdm_rpc_check_in.sql`:

```sql
create or replace function pdm.check_in(
  p_file_id uuid,
  p_sha256 text,
  p_size bigint,
  p_comment text
) returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_parent_version uuid;
  v_new_version pdm.versions;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  -- Verify caller holds the active lock and capture lock id.
  select id into v_lock_id
  from pdm.locks
  where file_id = p_file_id
    and user_id = v_caller
    and released_at is null
  for update;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  -- Determine next version number and parent version.
  select coalesce(max(version_num), 0) + 1, max(id)
  into v_next_num, v_parent_version
  from pdm.versions
  where file_id = p_file_id;

  -- Insert the new version.
  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (
    p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version
  )
  returning * into v_new_version;

  -- Update files.latest_version_id.
  update pdm.files set latest_version_id = v_new_version.id where id = p_file_id;

  -- Release the lock.
  update pdm.locks set released_at = now() where id = v_lock_id;

  return v_new_version;
end;
$$;

-- Public proxy so PostgREST exposes it as pdm_check_in.
create or replace function public.pdm_check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
) returns pdm.versions
language sql security definer set search_path = pdm, public
as $$ select pdm.check_in(p_file_id, p_sha256, p_size, p_comment); $$;

grant execute on function public.pdm_check_in(uuid, text, bigint, text) to authenticated;
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rpc-check-in.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000500_pdm_rpc_check_in.sql \
        infra/pdm-supabase/tests/rpc-check-in.test.ts
git commit -m "feat(pdm): pdm.check_in() RPC — atomic version insert + lock release"
```

---

## Task 7: RPC `pdm.force_unlock()`

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000600_pdm_rpc_force_unlock.sql`
- Create: `infra/pdm-supabase/tests/rpc-force-unlock.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rpc-force-unlock.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedFile(adminId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return file!.id;
}

describe("pdm.force_unlock()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("admin can force-unlock another user's lock; sets force_released_by", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const eClient = await signInAs(editor.email!);
    const { data: lock } = await eClient.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();

    const aClient = await signInAs(admin.email!);
    const { error } = await aClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "left for the day" });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: locks } = await svc.from("locks").select("released_at, force_released_by").eq("id", lock!.id).single();
    expect(locks!.released_at).not.toBeNull();
    expect(locks!.force_released_by).toBe(admin.id);
  });

  it("non-admin cannot force-unlock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const fileId = await seedFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { data: lock } = await aClient.from("locks").insert({ file_id: fileId, user_id: a.id }).select().single();

    const bClient = await signInAs(b.email!);
    const { error } = await bClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "trying" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/admin/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rpc-force-unlock.test.ts
```

Expected: failures (function does not exist).

- [ ] **Step 3: Add the RPC migration**

`infra/pdm-supabase/supabase/migrations/20260507000600_pdm_rpc_force_unlock.sql`:

```sql
create or replace function pdm.force_unlock(
  p_lock_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;
  if not pdm.is_admin() then
    raise exception 'admin role required to force-unlock';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required for force-unlock';
  end if;

  update pdm.locks
  set released_at = now(), force_released_by = v_caller
  where id = p_lock_id and released_at is null;

  if not found then
    raise exception 'lock % not active or not found', p_lock_id;
  end if;
end;
$$;

create or replace function public.pdm_force_unlock(p_lock_id uuid, p_reason text)
returns void
language sql security definer set search_path = pdm, public
as $$ select pdm.force_unlock(p_lock_id, p_reason); $$;

grant execute on function public.pdm_force_unlock(uuid, text) to authenticated;
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rpc-force-unlock.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000600_pdm_rpc_force_unlock.sql \
        infra/pdm-supabase/tests/rpc-force-unlock.test.ts
git commit -m "feat(pdm): pdm.force_unlock() RPC — admin-only, reason required"
```

---

## Task 8: RPC `pdm.cancel_checkout()`

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000700_pdm_rpc_cancel_checkout.sql`
- Create: `infra/pdm-supabase/tests/rpc-cancel-checkout.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/rpc-cancel-checkout.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedFile(adminId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return file!.id;
}

describe("pdm.cancel_checkout()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("releases the caller's own lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const { error } = await c.rpc("pdm_cancel_checkout", { p_file_id: fileId });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: locks } = await svc.from("locks").select("released_at, force_released_by").eq("file_id", fileId);
    expect(locks!.every((l) => l.released_at !== null)).toBe(true);
    expect(locks!.every((l) => l.force_released_by === null)).toBe(true);
  });

  it("rejects when the caller has no active lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.rpc("pdm_cancel_checkout", { p_file_id: fileId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no active lock/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test rpc-cancel-checkout.test.ts
```

Expected: failures (function does not exist).

- [ ] **Step 3: Add the RPC migration**

`infra/pdm-supabase/supabase/migrations/20260507000700_pdm_rpc_cancel_checkout.sql`:

```sql
create or replace function pdm.cancel_checkout(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  update pdm.locks
  set released_at = now()
  where file_id = p_file_id
    and user_id = v_caller
    and released_at is null;

  if not found then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;
end;
$$;

create or replace function public.pdm_cancel_checkout(p_file_id uuid)
returns void
language sql security definer set search_path = pdm, public
as $$ select pdm.cancel_checkout(p_file_id); $$;

grant execute on function public.pdm_cancel_checkout(uuid) to authenticated;
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test rpc-cancel-checkout.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000700_pdm_rpc_cancel_checkout.sql \
        infra/pdm-supabase/tests/rpc-cancel-checkout.test.ts
git commit -m "feat(pdm): pdm.cancel_checkout() RPC — release self-held lock without check-in"
```

---

## Task 9: Storage bucket `vault-objects` + storage RLS

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000800_pdm_storage.sql`
- Create: `infra/pdm-supabase/tests/storage.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/storage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

const BUCKET = "vault-objects";

describe("vault-objects storage bucket", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("bucket exists and is private", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.storage.getBucket(BUCKET);
    expect(error).toBeNull();
    expect(data?.public).toBe(false);
  });

  it("authenticated user can request a signed upload URL and PUT bytes", async () => {
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor");
    const c = await signInAs(u.email!);

    const sha = "abcdef".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    // Request signed upload URL.
    const { data: signed, error: signErr } = await c.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectPath);
    expect(signErr).toBeNull();
    expect(signed?.signedUrl).toBeTruthy();

    // PUT bytes via fetch using the signed URL.
    const body = new TextEncoder().encode("hello vault");
    const putRes = await fetch(signed!.signedUrl, {
      method: "PUT",
      body,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(putRes.ok).toBe(true);

    // Confirm the object exists by re-listing.
    const svc = serviceClient();
    const { data: list } = await svc.storage.from(BUCKET).list(sha.slice(0, 2));
    expect(list?.some((f) => f.name === sha)).toBe(true);
  });

  it("authenticated user can read via signed download URL", async () => {
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor");
    const sha = "deadbeef".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    // Seed via service client.
    const svc = serviceClient();
    await svc.storage.from(BUCKET).upload(objectPath, new Uint8Array([1, 2, 3]), {
      contentType: "application/octet-stream",
      upsert: true,
    });

    const c = await signInAs(u.email!);
    const { data, error } = await c.storage.from(BUCKET).createSignedUrl(objectPath, 60);
    expect(error).toBeNull();
    const got = await fetch(data!.signedUrl);
    expect(got.ok).toBe(true);
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test storage.test.ts
```

Expected: failures because the bucket doesn't exist.

- [ ] **Step 3: Add the storage migration**

`infra/pdm-supabase/supabase/migrations/20260507000800_pdm_storage.sql`:

```sql
-- Create the private bucket. INSERT into storage.buckets is the canonical
-- migration-time path (Supabase Storage uses regular Postgres tables under the hood).
insert into storage.buckets (id, name, public)
values ('vault-objects', 'vault-objects', false)
on conflict (id) do nothing;

-- RLS for storage.objects (already enabled by Supabase Storage; we just add policies).

-- Authenticated users can read via signed URLs (Supabase Storage handles the
-- signed-URL bypass automatically; this policy lets them list/get raw objects
-- when the JS client falls back to authenticated GETs).
create policy "vault-objects read for authenticated" on storage.objects
  for select to authenticated
  using (bucket_id = 'vault-objects');

-- Authenticated users can upload (the JS client's createSignedUploadUrl path).
create policy "vault-objects insert for authenticated" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vault-objects');

-- No update / delete from clients. The bucket is content-addressed and
-- immutable; lifecycle / cleanup happens via service-role admin tools later.
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test storage.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000800_pdm_storage.sql \
        infra/pdm-supabase/tests/storage.test.ts
git commit -m "feat(pdm): vault-objects storage bucket + RLS for signed URL flow"
```

---

## Task 10: Audit log triggers (auto-write on every state-changing op)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260507000900_pdm_audit_triggers.sql`
- Create: `infra/pdm-supabase/tests/audit-log.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/pdm-supabase/tests/audit-log.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedFile(adminId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return file!.id;
}

describe("audit log triggers", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("acquiring a lock writes a check_out audit row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data: lock } = await c.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, target_type, target_id, user_id")
      .eq("target_id", lock!.id);
    expect(rows!.some((r) => r.action === "check_out")).toBe(true);
    expect(rows!.find((r) => r.action === "check_out")!.user_id).toBe(editor.id);
  });

  it("check_in writes a check_in audit row referencing the version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { data: ver } = await c.rpc("pdm_check_in", {
      p_file_id: fileId, p_sha256: "a".repeat(64), p_size: 1, p_comment: "init",
    });

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, target_type, target_id")
      .eq("target_id", ver.id);
    expect(rows!.some((r) => r.action === "check_in" && r.target_type === "version")).toBe(true);
  });

  it("force_unlock writes an audit row including the reason", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const eClient = await signInAs(editor.email!);
    const { data: lock } = await eClient.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();
    const aClient = await signInAs(admin.email!);
    await aClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "left for the day" });

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, payload, user_id")
      .eq("target_id", lock!.id)
      .eq("action", "force_unlock");
    expect(rows!.length).toBe(1);
    expect(rows![0].payload).toMatchObject({ reason: "left for the day" });
    expect(rows![0].user_id).toBe(admin.id);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test audit-log.test.ts
```

Expected: failures because nothing currently writes to `pdm.audit_log`.

- [ ] **Step 3: Add the audit triggers and update RPCs to write audit rows**

`infra/pdm-supabase/supabase/migrations/20260507000900_pdm_audit_triggers.sql`:

```sql
-- Trigger: writing a row to pdm.locks => audit row.
create or replace function pdm.trg_locks_audit() returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  if (TG_OP = 'INSERT') then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (NEW.user_id, 'check_out', 'lock', NEW.id, jsonb_build_object('file_id', NEW.file_id));
    return NEW;
  end if;
  return NEW;
end;
$$;

create trigger locks_audit_insert
  after insert on pdm.locks
  for each row execute function pdm.trg_locks_audit();

-- Update pdm.check_in to write its own audit row (we keep the trigger above for
-- pure direct inserts; check_in inserts a version row, which we audit separately).
create or replace function pdm.check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
) returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_parent_version uuid;
  v_new_version pdm.versions;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  select id into v_lock_id
  from pdm.locks
  where file_id = p_file_id and user_id = v_caller and released_at is null
  for update;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  select coalesce(max(version_num), 0) + 1, max(id)
  into v_next_num, v_parent_version
  from pdm.versions where file_id = p_file_id;

  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version)
  returning * into v_new_version;

  update pdm.files set latest_version_id = v_new_version.id where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (
    v_caller,
    'check_in',
    'version',
    v_new_version.id,
    jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num, 'sha256', p_sha256)
  );

  return v_new_version;
end;
$$;

-- Update pdm.force_unlock to write an audit row with the reason.
create or replace function pdm.force_unlock(p_lock_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.is_admin() then raise exception 'admin role required to force-unlock'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required for force-unlock';
  end if;

  update pdm.locks
  set released_at = now(), force_released_by = v_caller
  where id = p_lock_id and released_at is null;

  if not found then raise exception 'lock % not active or not found', p_lock_id; end if;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (v_caller, 'force_unlock', 'lock', p_lock_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- Update pdm.cancel_checkout similarly.
create or replace function pdm.cancel_checkout(p_file_id uuid) returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_lock_id uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  update pdm.locks
  set released_at = now()
  where file_id = p_file_id and user_id = v_caller and released_at is null
  returning id into v_lock_id;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (v_caller, 'cancel_checkout', 'lock', v_lock_id, jsonb_build_object('file_id', p_file_id));
end;
$$;
```

- [ ] **Step 4: Re-apply and re-run**

```bash
pnpm db:reset
pnpm test audit-log.test.ts rpc-check-in.test.ts rpc-force-unlock.test.ts rpc-cancel-checkout.test.ts
```

Expected: all tests in all four files pass — the redefined RPCs continue to satisfy their original tests, and the new audit-log tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260507000900_pdm_audit_triggers.sql \
        infra/pdm-supabase/tests/audit-log.test.ts
git commit -m "feat(pdm): audit-log triggers + RPC audit writes (check_out, check_in, force_unlock, cancel_checkout)"
```

---

## Task 11: Bootstrap-admin script

**Files:**
- Create: `infra/pdm-supabase/scripts/bootstrap-admin.ts`
- Modify: `infra/pdm-supabase/README.md` (already covers usage; leave as-is)

- [ ] **Step 1: Write the script**

`infra/pdm-supabase/scripts/bootstrap-admin.ts`:

```ts
#!/usr/bin/env tsx
/**
 * One-shot: create or promote the first admin user.
 *
 * Usage:
 *   pnpm bootstrap:admin -- --email me@example.com [--password 'temp123']
 *
 * If --password is omitted and the user doesn't exist, a random temporary
 * password is generated and printed once. The admin must change it on first login.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("email");
  if (!email) {
    console.error("usage: bootstrap-admin -- --email <email> [--password <pw>]");
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  const svc = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Find or create the user.
  const { data: list, error: listErr } = await svc.auth.admin.listUsers();
  if (listErr) throw listErr;
  let user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (!user) {
    const password = arg("password") ?? randomBytes(12).toString("base64url");
    const { data, error } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    user = data.user!;
    console.log(`Created auth user: ${user.email} (id=${user.id})`);
    if (!arg("password")) {
      console.log(`Temporary password (change on first login): ${password}`);
    }
  } else {
    console.log(`Found existing auth user: ${user.email} (id=${user.id})`);
  }

  // Upsert into pdm.user_roles with role=admin.
  const { error: roleErr } = await svc
    .from("user_roles")
    .upsert({ user_id: user.id, role: "admin" }, { onConflict: "user_id" });
  if (roleErr) throw roleErr;
  console.log(`Granted role=admin to ${user.email}.`);

  console.log("\nDone. The user can now log in via Helios and access all admin operations.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify the script works against the local Supabase**

```bash
cd infra/pdm-supabase
pnpm bootstrap:admin -- --email nick532219@gmail.com --password 'helios-local-test'
```

Expected output (substantively):
```
Created auth user: nick532219@gmail.com (id=...)
Granted role=admin to nick532219@gmail.com.

Done. The user can now log in via Helios and access all admin operations.
```

Then verify in the database:

```bash
supabase db inspect role-grants 2>/dev/null || \
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    -c "select user_id, role from pdm.user_roles;"
```

Expected: a single row with `role = admin`.

Re-run the script with the same email to verify idempotency:

```bash
pnpm bootstrap:admin -- --email nick532219@gmail.com
```

Expected: `Found existing auth user: ...` and `Granted role=admin ...` — no error.

- [ ] **Step 3: Commit**

```bash
git add infra/pdm-supabase/scripts/bootstrap-admin.ts
git commit -m "feat(pdm): bootstrap-admin script — promote first admin user"
```

---

## Task 12: Plan-completion review

**Files:**
- Modify: `docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md` (mark Plan 1 status)
- Create: `infra/pdm-supabase/tests/end-to-end.test.ts`

The point of this task is to add one end-to-end test that exercises an entire happy-path flow (create vault → create folder → create file → check out → check in → see history → admin force-unlock on a second checkout), then update the roadmap.

- [ ] **Step 1: Write the end-to-end test**

`infra/pdm-supabase/tests/end-to-end.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("end-to-end: a designer's working day", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("create vault → check out → check in → check out again → admin force-unlocks", async () => {
    // Setup users.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const designer = await createTestUser(uniqueEmail("designer"));
    await setRole(designer.id, "editor");

    // Admin: create vault, folder, file.
    const aClient = await signInAs(admin.email!);
    const { data: vault } = await aClient
      .from("vaults").insert({ name: "sdm26", created_by: admin.id }).select().single();
    const { data: folder } = await aClient
      .from("folders").insert({ vault_id: vault!.id, name: "chassis" }).select().single();
    const { data: file } = await aClient
      .from("files").insert({ vault_id: vault!.id, folder_id: folder!.id, name: "frame.sldprt" }).select().single();

    // Designer: check out, check in v1.
    const dClient = await signInAs(designer.email!);
    await dClient.from("locks").insert({ file_id: file!.id, user_id: designer.id });
    const { data: v1 } = await dClient.rpc("pdm_check_in", {
      p_file_id: file!.id, p_sha256: "1".repeat(64), p_size: 100, p_comment: "first cut",
    });
    expect(v1.version_num).toBe(1);

    // Designer: check out again. Goes to vacation mid-edit.
    const { data: lock2 } = await dClient
      .from("locks").insert({ file_id: file!.id, user_id: designer.id }).select().single();

    // Admin: force-unlocks because designer is unreachable.
    await aClient.rpc("pdm_force_unlock", { p_lock_id: lock2!.id, p_reason: "designer on vacation, blocking team" });

    // Verify: file's latest_version_id still points at v1; lock2 marked released by admin.
    const svc = serviceClient();
    const { data: fileNow } = await svc.from("files").select("latest_version_id").eq("id", file!.id).single();
    expect(fileNow!.latest_version_id).toBe(v1.id);

    const { data: locks } = await svc.from("locks").select("id, released_at, force_released_by").eq("file_id", file!.id);
    const lock2Now = locks!.find((l) => l.id === lock2!.id)!;
    expect(lock2Now.released_at).not.toBeNull();
    expect(lock2Now.force_released_by).toBe(admin.id);

    // Verify audit trail covers all five operations.
    const { data: audit } = await svc
      .from("audit_log").select("action").order("ts", { ascending: true });
    const actions = audit!.map((r) => r.action);
    expect(actions).toEqual(["check_out", "check_in", "check_out", "force_unlock"]);
  });
});
```

- [ ] **Step 2: Run the full test suite**

```bash
cd infra/pdm-supabase
pnpm db:reset
pnpm test
```

Expected: every test in every file passes. Tally should be roughly: schema(2) + rls-roles(4) + rls-structure(3) + rls-locks(5) + rls-versions(3) + rpc-check-in(3) + rpc-force-unlock(2) + rpc-cancel-checkout(2) + storage(3) + audit-log(3) + end-to-end(1) = ~31 tests.

- [ ] **Step 3: Update the roadmap status**

Edit `docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`. In the table row for Plan 1, change `not started` to `complete (<commit-sha>)` where `<commit-sha>` is the short SHA of the most recent commit on this plan (`git log -1 --format=%h`).

- [ ] **Step 4: Final commit**

```bash
git add infra/pdm-supabase/tests/end-to-end.test.ts \
        docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md
git commit -m "test(pdm): end-to-end happy-path test; mark Plan 1 complete in roadmap"
```

- [ ] **Step 5: DO NOT push.** Per the roadmap, no pushes to remote until Plan 4 lands at the earliest. Confirm with `git status` and `git log origin/main..HEAD` to see the local-only commits, then stop.

---

## What Plan 2 picks up

The next plan (`2026-05-07-helios-vault-2-crates.md`) will:
- Add `crates/pdm-core` with shared domain types (`Vault`, `Folder`, `File`, `Version`, `Lock`, `Ref`, `UserRole`).
- Add `crates/pdm-client` — a typed Rust wrapper around `supabase-rs` (or a hand-rolled HTTP client if the ecosystem isn't ready) that exposes the same operations the integration tests in this plan exercise.
- Add `crates/pdm-sw-parser` — a CFB-format parser that extracts reference-path strings from `.sldasm` / `.sldprt`. Will compile to WASM in Plan 5.

All three crates will have their own `cargo test` suites; `pdm-client` will reuse this plan's local Supabase as its integration-test target.
