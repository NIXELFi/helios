-- Archived vaults: previous years' cars (SDM25, SDM26, ...). Helios does not
-- auto-sync an archived vault; members fetch what they need with Get Latest /
-- Download. Every member auto-syncing every old car is most of the vault's
-- steady storage egress (SDM25 alone is ~25 GB of latest versions).
--
-- Data-driven, not hard-coded: vault admins flip it in Vault Settings. Writes go
-- through the existing vaults_update_admin RLS policy, like spotlight_file_id.
-- Additive with a default, so older Helios builds (which select *) are
-- unaffected and simply keep syncing until they update.
--
-- Apply with the Management API query endpoint (never `supabase db push`;
-- hosted migration history has drifted), then record the version.
alter table pdm.vaults
  add column if not exists archived boolean not null default false;

comment on column pdm.vaults.archived is
  'Previous-year vault: Helios skips auto-sync for it (download on demand). Admin-changeable via the vaults UPDATE RLS policy.';
