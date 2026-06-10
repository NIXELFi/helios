-- Performance + integrity hardening (2026-06-09 vault audit / Supabase advisors).
--
--  * files.vault_id had NO index — the BrowseScreen "files by vault" hot path
--    was a full Seq Scan over the whole table on every poll/realtime refresh
--    (verified via EXPLAIN against the hosted project).
--  * Every pdm foreign key was unindexed (advisor: unindexed_foreign_keys).
--  * versions.sha256 gains an index for the content-addressed storage SELECT
--    policy (20260610110000) and dedup probes.
--  * pdm.user_roles lost its primary key in 20260531000000 when user_id went
--    from PK to one-row-per-(user, vault) (advisor: no_primary_key).
--  * Top-level files (folder_id IS NULL) had no name uniqueness: the schema's
--    unique(folder_id, name) treats NULLs as distinct, so two files with the
--    same name could coexist at a vault root (checked live data: no
--    violations). Mirrors the in-folder constraint exactly.

-- Hot path + FK indexes.
create index if not exists files_by_vault            on pdm.files (vault_id);
create index if not exists files_latest_version_idx  on pdm.files (latest_version_id);
create index if not exists files_created_by_idx      on pdm.files (created_by);
create index if not exists files_deleted_by_idx      on pdm.files (deleted_by) where deleted_by is not null;
create index if not exists folders_by_parent         on pdm.folders (parent_id);
create index if not exists versions_by_sha           on pdm.versions (sha256);
create index if not exists versions_author_idx       on pdm.versions (author_id);
create index if not exists versions_parent_idx       on pdm.versions (parent_version_id) where parent_version_id is not null;
create index if not exists locks_by_file             on pdm.locks (file_id);
create index if not exists locks_by_user_all         on pdm.locks (user_id);
create index if not exists locks_force_released_idx  on pdm.locks (force_released_by) where force_released_by is not null;
create index if not exists audit_log_by_user         on pdm.audit_log (user_id);
create index if not exists user_roles_by_vault       on pdm.user_roles (vault_id) where vault_id is not null;
create index if not exists vaults_created_by_idx     on pdm.vaults (created_by);

-- Restore a primary key on pdm.user_roles (surrogate — the natural key is the
-- expression index user_roles_user_vault_uniq, which Postgres cannot promote
-- to a PK).
alter table pdm.user_roles add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pdm.user_roles'::regclass and contype = 'p'
  ) then
    alter table pdm.user_roles add constraint user_roles_pkey primary key (id);
  end if;
end $$;

-- One live name per vault root, matching unique(folder_id, name) semantics
-- for the in-folder case (soft-deleted rows keep their name reserved there
-- too, so behavior stays consistent across both levels).
create unique index if not exists files_top_level_name_uniq
  on pdm.files (vault_id, name)
  where folder_id is null;
