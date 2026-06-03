-- Per-vault "spotlight" file: the project's flagship / master assembly, surfaced
-- as the hero card in the new Vault Insights view. DB-stored (not hardcoded) and
-- user-changeable; writes go through the existing vaults_update_admin RLS policy
-- (admin-only), matching how other vault-level settings are managed. ON DELETE
-- SET NULL so the spotlight clears itself if the chosen file is ever removed.
--
-- Applied to dlmyixonuyckxkknolku via MCP apply_migration (not db push — hosted
-- history is drifted); this file keeps the repo in sync. The three SDM vaults
-- were seeded to their master assemblies via a one-off data UPDATE (not part of
-- this schema migration).
alter table pdm.vaults
  add column if not exists spotlight_file_id uuid
  references pdm.files(id) on delete set null;

comment on column pdm.vaults.spotlight_file_id is
  'Optional flagship file for the vault (master assembly), shown in Vault Insights. Admin-changeable via the vaults UPDATE RLS policy.';
