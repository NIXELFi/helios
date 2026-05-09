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
