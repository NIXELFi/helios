-- v5.0.0 Marketplace — Sub-project B, Phase 1: schema + tables.
-- Plan: docs/superpowers/plans/2026-06-25-v5-subproject-B-marketplace-backend.md
--
-- A new `marketplace` schema holds the published plugin catalog: `plugins`
-- (one row per add-on), `plugin_versions` (immutable, content-addressed,
-- reviewed, signed releases), and `plugin_installs` (per-user, explicit).
-- RLS + capabilities land in the next migration (…_marketplace_rls.sql); writes
-- here are all funnelled through SECURITY DEFINER RPCs (…_marketplace_rpcs.sql),
-- so this file only defines structure. Every statement is idempotent.

create schema if not exists marketplace;

-- ---------------------------------------------------------------------------
-- 1. plugins — one row per add-on (keyed by the manifest id).
--    `subteam` is the OWNING subteam, set by the publisher at publish time from
--    their own context (it is NOT a manifest field). NULL = an org-wide plugin,
--    publishable only by an org-scoped publisher (Executive/Owner). `latest_version`
--    is the newest APPROVED version, denormalized for cheap listing.
-- ---------------------------------------------------------------------------
create table if not exists marketplace.plugins (
  id             text primary key,                                  -- manifest id, e.g. 'aero.downforce-calculator'
  name           text not null,
  subteam        uuid references pm.subteams(id) on delete set null,
  is_recommended boolean not null default false,                    -- subteam "recommended" flag (decision #2)
  latest_version text,                                              -- newest APPROVED version (denormalized)
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists plugins_subteam_idx on marketplace.plugins (subteam);

-- ---------------------------------------------------------------------------
-- 2. plugin_versions — immutable releases. Content-addressed by `bundle_sha256`
--    (the storage key); `signature` is an Ed25519 detached signature over the
--    canonical signing message (see …_marketplace_signing.sql), produced at
--    publish time and verified by the desktop before install. `review_status`
--    gates installability; the review_* columns are written by D's review RPC
--    (included here so D needs no schema change).
-- ---------------------------------------------------------------------------
create table if not exists marketplace.plugin_versions (
  plugin_id      text not null references marketplace.plugins(id) on delete cascade,
  version        text not null,                                     -- plugin semver
  manifest       jsonb not null,                                    -- the full validated manifest
  permissions    text[] not null default '{}',                     -- denormalized declared permissions
  bundle_sha256  text not null,                                     -- content-addressed storage key (hex)
  bundle_bytes   bigint not null check (bundle_bytes > 0 and bundle_bytes <= 26214400), -- 25 MiB cap (decision: B#4)
  review_status  text not null default 'pending'
                   check (review_status in ('pending','approved','rejected')),
  signature      text,                                              -- base64 Ed25519 detached sig (null until signed)
  sig_alg        text,                                              -- e.g. 'ed25519' (null until signed)
  signing_key_id text,                                              -- which signing key (marketplace.signing_keys.id)
  published_by   uuid not null references auth.users(id),
  published_at   timestamptz not null default now(),
  reviewed_by    uuid references auth.users(id),                    -- set by the review RPC (D)
  reviewed_at    timestamptz,
  review_notes   text,
  primary key (plugin_id, version)
);
create index if not exists plugin_versions_status_idx
  on marketplace.plugin_versions (plugin_id, review_status);
-- One content hash per row is fine to duplicate across versions, but each
-- (plugin, version) is unique via the PK; the sha256 is the storage dedup key.
create index if not exists plugin_versions_sha_idx
  on marketplace.plugin_versions (bundle_sha256);

-- ---------------------------------------------------------------------------
-- 3. plugin_installs — per-user, explicit install (decision #2). A user has at
--    most one installed version of a plugin at a time.
-- ---------------------------------------------------------------------------
create table if not exists marketplace.plugin_installs (
  user_id           uuid not null references auth.users(id) on delete cascade,
  plugin_id         text not null references marketplace.plugins(id) on delete cascade,
  installed_version text not null,
  installed_at      timestamptz not null default now(),
  primary key (user_id, plugin_id),
  -- An install must point at a real version of that plugin.
  foreign key (plugin_id, installed_version)
    references marketplace.plugin_versions (plugin_id, version) on delete cascade
);
create index if not exists plugin_installs_user_idx on marketplace.plugin_installs (user_id);

-- ---------------------------------------------------------------------------
-- 4. Owning-subteam lookup, SECURITY DEFINER so it can be used safely inside RLS
--    policies (a plain subquery on `plugins` from within another table's policy
--    would itself be filtered by plugins' RLS; this bypasses that to read just
--    the one column). Used by the plugin_versions + storage.objects policies.
-- ---------------------------------------------------------------------------
create or replace function marketplace.plugin_subteam(p_plugin_id text)
returns uuid language sql stable security definer
set search_path = marketplace, public as $$
  select subteam from marketplace.plugins where id = p_plugin_id;
$$;
grant execute on function marketplace.plugin_subteam(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Schema usage. RLS policies + per-table SELECT grants arrive in the RLS
--    migration; PostgREST needs USAGE on the schema to expose anything.
-- ---------------------------------------------------------------------------
grant usage on schema marketplace to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Extend the test-reset fixture so marketplace rows don't leak between RLS
--    tests. `pdm.test_reset()` (20260508000100) currently truncates pdm.* only;
--    re-create it with the marketplace tables added (FK children first). The body
--    is otherwise an exact copy of the current definition — keep them in sync if
--    pdm.test_reset changes upstream. Guarded the same way (SECURITY DEFINER; the
--    JS harness only calls it against the test database).
-- ---------------------------------------------------------------------------
create or replace function pdm.test_reset()
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  -- WHERE true clauses are required because Supabase enables pg_safeupdate,
  -- which blocks bare DELETE / UPDATE even inside SECURITY DEFINER functions.

  -- marketplace.* first (FK children before parents): installs -> versions ->
  -- plugins. Schema-qualified so the pdm/public search_path doesn't matter.
  delete from marketplace.plugin_installs where true;
  delete from marketplace.plugin_versions where true;
  delete from marketplace.plugins where true;

  delete from pdm.audit_log where true;
  delete from pdm.refs where true;
  delete from pdm.versions where true;
  delete from pdm.locks where true;
  update pdm.files set latest_version_id = null where true;
  delete from pdm.files where true;
  delete from pdm.folders where true;
  delete from pdm.vaults where true;
  delete from pdm.user_roles where true;
  -- Storage objects are wiped via the Storage API on the JS test side
  -- (see resetPdmTables in tests/setup.ts). Supabase blocks direct DELETE
  -- on storage.objects with a trigger.
end;
$$;
