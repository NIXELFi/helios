-- Audit follow-ups (2026-07-14 vault prod-readiness audit): finish the
-- capability bridge on the three surfaces the first two waves missed.
--
--   B1  pdm_has_vault_access(): the Vault module's access wall probed
--       pdm.user_roles directly, so capability-only members (org-tool
--       Engineer/Lead grants; every future onboarded member) passed RLS but
--       were told "your account isn't authorized". New definer probe = any
--       legacy row OR vault.view capability; the client hook now calls it.
--   M4  pdm.vaults INSERT/UPDATE/DELETE gated on bare legacy pdm.is_admin():
--       no capability path (an org-tool exec can't create next season's
--       vault) and no vault scoping (the C-3-class gap survived here).
--       Repointed at pdm.is_admin_in(id) — bridged AND per-vault.
--   H2  pm.effective_role() only resolved legacy team/subteam_memberships
--       (+ the pdm_team_role fallback), so org-granted members could READ pm
--       but not create/edit tasks — the exact bug class 20260714000000 fixed
--       for the vault, one surface over. New pm.org_team_role() derives a
--       team_role from CAPABILITIES (not role keys, which are editable data):
--         org-scoped org.grant_roles            → admin
--         pm.grant_subteam_roles for the subteam → lead
--         pm.edit_tasks via any membership       → engineer
--         pm.view via any membership             → viewer
--       pm.edit_tasks is deliberately scope-blind, matching 20260623000000
--       ("PM editors edit all subteam tasks" — owner decision from a bug
--       report); leads keep subteam-scoped lead powers.

-- 1. (B1) Vault-module access probe.
create or replace function pdm.has_vault_access()
returns boolean language sql stable security definer set search_path = pdm, pm, public as $$
  select exists (
    select 1 from pdm.user_roles where user_id = (select auth.uid())
  ) or pdm.has_vault_capability('vault.view');
$$;
revoke all on function pdm.has_vault_access() from public, anon;
grant execute on function pdm.has_vault_access() to authenticated;

create or replace function pdm.pdm_has_vault_access()
returns boolean language sql stable security definer set search_path = pdm, public
as $$ select pdm.has_vault_access(); $$;
revoke all on function pdm.pdm_has_vault_access() from public, anon;
grant execute on function pdm.pdm_has_vault_access() to authenticated;

-- 2. (M4) Vault DML: bridged + per-vault instead of bare global legacy admin.
drop policy if exists vaults_insert_admin on pdm.vaults;
create policy vaults_insert_admin on pdm.vaults
  for insert to authenticated with check (pdm.is_admin_in(id));

drop policy if exists vaults_update_admin on pdm.vaults;
create policy vaults_update_admin on pdm.vaults
  for update to authenticated
  using (pdm.is_admin_in(id)) with check (pdm.is_admin_in(id));

drop policy if exists vaults_delete_admin on pdm.vaults;
create policy vaults_delete_admin on pdm.vaults
  for delete to authenticated using (pdm.is_admin_in(id));

-- 3. (H2) PM team-role from capabilities.
create or replace function pm.org_team_role(uid uuid, stid uuid)
returns pm.team_role language sql stable security definer set search_path = pm, public as $$
  select case
    when pm.has_capability(uid, 'org.grant_roles', null) then 'admin'::pm.team_role
    when stid is not null and pm.has_capability(uid, 'pm.grant_subteam_roles', stid) then 'lead'::pm.team_role
    when exists (
      select 1 from pm.role_memberships m
      join pm.role_capabilities rc on rc.role_id = m.role_id
      where m.user_id = uid and rc.capability_key = 'pm.edit_tasks'
    ) then 'engineer'::pm.team_role
    when exists (
      select 1 from pm.role_memberships m
      join pm.role_capabilities rc on rc.role_id = m.role_id
      where m.user_id = uid and rc.capability_key = 'pm.view'
    ) then 'viewer'::pm.team_role
    else null
  end;
$$;

-- effective_role: legacy sources verbatim, plus the capability-derived rank.
create or replace function pm.effective_role(uid uuid, pid uuid, stid uuid)
returns pm.team_role language sql stable security definer set search_path = pm, public as $$
  with r as (
    select pm.user_role_in_project(uid, pid)::text as pr,
           pm.user_role_in_subteam(uid, stid)::text as st,
           pm.org_team_role(uid, stid)::text as org
  )
  select case
    when not (pm.is_project_member(uid, pid) or pm.can_read_pm(uid)) then null
    when 'admin'    in (pr, st, org) then 'admin'::pm.team_role
    when 'lead'     in (pr, st, org) then 'lead'::pm.team_role
    when 'engineer' in (pr, st, org) then 'engineer'::pm.team_role
    when 'viewer'   in (pr, st, org) then 'viewer'::pm.team_role
    else null
  end
  from r;
$$;
