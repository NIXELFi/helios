-- Vault-scoped READ RLS (2026-06-09 vault audit: cross-vault read exposure).
--
-- Before: folders/versions/locks/refs/audit_log SELECT were using(true) and
-- files SELECT was draft-aware but not vault-aware — any authenticated role
-- holder could read every vault's metadata (file names, version history,
-- lock activity, data-card properties) via direct PostgREST reads or
-- realtime. The desktop app reads these tables directly (useFiles /
-- useFolders / useLocks / useReferences / HistoryScreen), always filtered to
-- the active vault, so member-scoping is invisible to legitimate use: a
-- GLOBAL role row (vault_id IS NULL) — what every current team member holds —
-- is authoritative in every vault, same as pdm.is_admin_in/can_edit_in.
--
-- pdm.vaults intentionally stays readable to all authenticated users: the
-- vault switcher lists vaults you are not (yet) a member of.

-- Membership helper, mirroring is_admin_in/can_edit_in (any role counts).
create or replace function pdm.is_member_in(p_vault_id uuid)
returns boolean language sql stable security definer set search_path = pdm, public as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid()
      and (vault_id is null or vault_id = p_vault_id)
  );
$$;
revoke all on function pdm.is_member_in(uuid) from public, anon;
grant execute on function pdm.is_member_in(uuid) to authenticated;

-- Vault lookups for policies on child tables (locks/versions/refs). These
-- MUST be security definer: an inline policy subquery on pdm.files runs under
-- the caller's files RLS, where another user's unpublished draft is invisible
-- — the lookup would return NULL and wrongly deny the row. (This exact
-- footgun broke locks_insert for per-vault editors; rls-per-vault-roles.test
-- catches it.)
create or replace function pdm.file_vault_id(p_file_id uuid)
returns uuid language sql stable security definer set search_path = pdm, public as $$
  select vault_id from pdm.files where id = p_file_id;
$$;
revoke all on function pdm.file_vault_id(uuid) from public, anon;
grant execute on function pdm.file_vault_id(uuid) to authenticated;

create or replace function pdm.version_vault_id(p_version_id uuid)
returns uuid language sql stable security definer set search_path = pdm, public as $$
  select f.vault_id from pdm.versions v join pdm.files f on f.id = v.file_id
  where v.id = p_version_id;
$$;
revoke all on function pdm.version_vault_id(uuid) from public, anon;
grant execute on function pdm.version_vault_id(uuid) to authenticated;

-- files: vault member AND (published or own draft) — preserves the draft
-- privacy introduced in 20260603100000.
drop policy if exists files_read on pdm.files;
create policy files_read on pdm.files
  for select to authenticated
  using (
    pdm.is_member_in(vault_id)
    and (published_at is not null or created_by = (select auth.uid()))
  );

drop policy if exists folders_read on pdm.folders;
create policy folders_read on pdm.folders
  for select to authenticated
  using (pdm.is_member_in(vault_id));

-- versions/locks carry file_id, refs carry parent_version_id → resolve the
-- vault through the definer helpers (NOT inline subqueries; see above).
drop policy if exists versions_read on pdm.versions;
create policy versions_read on pdm.versions
  for select to authenticated
  using (pdm.is_member_in(pdm.file_vault_id(file_id)));

drop policy if exists locks_read on pdm.locks;
create policy locks_read on pdm.locks
  for select to authenticated
  using (pdm.is_member_in(pdm.file_vault_id(file_id)));

drop policy if exists refs_read on pdm.refs;
create policy refs_read on pdm.refs
  for select to authenticated
  using (pdm.is_member_in(pdm.version_vault_id(parent_version_id)));

-- audit_log has no vault column; per-target vault resolution would need a
-- fragile join per action type. Tighten "any authenticated" to "role
-- holders" now; follow-up: stamp vault_id at write time and scope by it.
drop policy if exists audit_log_read on pdm.audit_log;
create policy audit_log_read on pdm.audit_log
  for select to authenticated
  using (exists (select 1 from pdm.user_roles ur where ur.user_id = (select auth.uid())));

-- user_roles: self-rows (useMyRole/useVaultAccess read with eq(user_id, me))
-- or admins. Member listing in the UI goes through the admin-gated definer
-- RPCs (pdm_admin_list_users / pdm_list_vault_roles), not direct reads.
drop policy if exists user_roles_read on pdm.user_roles;
create policy user_roles_read on pdm.user_roles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or pdm.is_admin()
    or (vault_id is not null and pdm.is_admin_in(vault_id))
  );

-- subteams: was readable by anon (roles {anon,authenticated}); org structure
-- should require a session.
drop policy if exists subteams_read on pdm.subteams;
create policy subteams_read on pdm.subteams
  for select to authenticated
  using (true);
