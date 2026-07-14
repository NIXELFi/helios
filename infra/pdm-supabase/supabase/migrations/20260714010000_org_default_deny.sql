-- Default-deny for accounts with no org role: team data is IP.
--
-- Owner decision (2026-07-14): a fresh signup must have NO read access to any
-- team data — vault, PM, dashboards, calendar, marketplace, games — until a
-- lead/exec grants them a role. Two things violated that:
--
--   1. The signup auto-provision trigger (20260619000700, softened by
--      20260622000200) handed every new account a global pdm 'viewer' row,
--      and pdm.is_member_in / pm.can_read_pm treat ANY pdm.user_roles row as
--      membership — so a brand-new self-signup could read every vault file
--      tree and the whole PM workspace.
--   2. A set of bare `using (true)` authenticated SELECT policies (vault list,
--      pm reference tables, dashboard photos, gcal mirror, games scores,
--      telemetry storage) predate the org model and were world-readable to any
--      authenticated account.
--
-- New model: "org member" = holds ANY pm role membership (Org & Access grant)
-- OR any legacy pdm.user_roles row (explicit vault grant). Everything below
-- gates on that. The client shows a "contact your team lead" screen for
-- non-members (release-side); these policies are the actual enforcement.

-- 1. Stop auto-provisioning roles at signup. New accounts start with nothing.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists pdm.handle_new_user();

-- 2. Remove the baseline rows the trigger already handed out. Scoped tightly:
--    global 'viewer' rows with no granter are exactly the auto-provisioned
--    shape; hand-granted viewer rows (granted_by set) are curated and stay.
delete from pdm.user_roles
where role = 'viewer' and granted_by is null and vault_id is null;

-- 3. Membership helpers. pm.can_read_pm(uid) already gates most pm.* SELECT
--    policies — teach it the org model (it only knew pdm.user_roles, which is
--    why the baseline viewer row unlocked PM). pm.is_org_member() is the
--    auth.uid() convenience used by policies and the client's access probe.
create or replace function pm.can_read_pm(uid uuid)
returns boolean language sql stable security definer set search_path = pm, pdm, public as $$
  select exists (select 1 from pdm.user_roles where user_id = uid)
      or exists (select 1 from pm.role_memberships where user_id = uid);
$$;

create or replace function pm.is_org_member()
returns boolean language sql stable security definer set search_path = pm, pdm, public as $$
  select pm.can_read_pm((select auth.uid()));
$$;
revoke all on function pm.is_org_member() from public, anon;
grant execute on function pm.is_org_member() to authenticated;

-- 4. Vault list: was `using (true)` — any authenticated account could see
--    every vault's name/metadata. Per-vault membership now required (global
--    legacy rows and vault.view capabilities pass via is_member_in).
drop policy if exists vaults_read on pdm.vaults;
create policy vaults_read on pdm.vaults
  for select to authenticated
  using (pdm.is_member_in(id));

-- 5. pm reference tables that were world-readable to authenticated.
drop policy if exists capabilities_read on pm.capabilities;
create policy capabilities_read on pm.capabilities
  for select to authenticated using (pm.is_org_member());

drop policy if exists roles_read on pm.roles;
create policy roles_read on pm.roles
  for select to authenticated using (pm.is_org_member());

drop policy if exists role_capabilities_read on pm.role_capabilities;
create policy role_capabilities_read on pm.role_capabilities
  for select to authenticated using (pm.is_org_member());

drop policy if exists dashboard_photos_read on pm.dashboard_photos;
create policy dashboard_photos_read on pm.dashboard_photos
  for select to authenticated using (pm.is_org_member());

drop policy if exists gcal_read on pm.gcal_events;
create policy gcal_read on pm.gcal_events
  for select to authenticated using (pm.is_org_member());

drop policy if exists project_hidden_subteams_read on pm.project_hidden_subteams;
create policy project_hidden_subteams_read on pm.project_hidden_subteams
  for select to authenticated using (pm.is_org_member());

drop policy if exists project_subteams_read on pm.project_subteams;
create policy project_subteams_read on pm.project_subteams
  for select to authenticated using (pm.is_org_member());

drop policy if exists "authenticated read subsystems" on pm.subsystems;
create policy "authenticated read subsystems" on pm.subsystems
  for select to authenticated using (pm.is_org_member());

drop policy if exists "authenticated read subteam_memberships" on pm.subteam_memberships;
create policy "authenticated read subteam_memberships" on pm.subteam_memberships
  for select to authenticated using (pm.is_org_member());

drop policy if exists "authenticated read subteams" on pm.subteams;
create policy "authenticated read subteams" on pm.subteams
  for select to authenticated using (pm.is_org_member());
-- NB: pdm.subteams keeps its anon read — the signup form's subteam picker
-- (public.list_signup_subteams) is SECURITY DEFINER either way, and subteam
-- names are already exposed pre-auth by design.

-- 6. Games: scores stay team-internal, and only members can post them.
drop policy if exists scores_read_authed on games.scores;
create policy scores_read_authed on games.scores
  for select to authenticated using (pm.is_org_member());

drop policy if exists scores_insert_own on games.scores;
create policy scores_insert_own on games.scores
  for insert to authenticated
  with check (user_id = (select auth.uid()) and pm.is_org_member());

-- 7. Marketplace: approved-plugin browsing was open to any authenticated
--    account. Wrap the existing quals (verbatim from prod) in membership.
drop policy if exists plugins_select on marketplace.plugins;
create policy plugins_select on marketplace.plugins
  for select to authenticated
  using (
    pm.is_org_member()
    and (
      exists (
        select 1 from marketplace.plugin_versions v
        where v.plugin_id = plugins.id and v.review_status = 'approved'
      )
      or pm.has_capability(auth.uid(), 'marketplace.publish', subteam)
      or pm.has_capability(auth.uid(), 'marketplace.review', subteam)
    )
  );

drop policy if exists plugin_versions_select on marketplace.plugin_versions;
create policy plugin_versions_select on marketplace.plugin_versions
  for select to authenticated
  using (
    pm.is_org_member()
    and (
      review_status = 'approved'
      or pm.has_capability(auth.uid(), 'marketplace.publish', marketplace.plugin_subteam(plugin_id))
      or pm.has_capability(auth.uid(), 'marketplace.review', marketplace.plugin_subteam(plugin_id))
    )
  );

-- 8. Storage buckets that were readable by any authenticated account.
drop policy if exists dash_photo_read on storage.objects;
create policy dash_photo_read on storage.objects
  for select to authenticated
  using (bucket_id = 'dashboard-photos' and pm.is_org_member());

drop policy if exists telemetry_sessions_authenticated_read on storage.objects;
create policy telemetry_sessions_authenticated_read on storage.objects
  for select to authenticated
  using (bucket_id = 'telemetry-sessions' and pm.is_org_member());

drop policy if exists marketplace_plugins_read on storage.objects;
create policy marketplace_plugins_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'plugins'
    and pm.is_org_member()
    and exists (
      select 1 from marketplace.plugin_versions v
      where v.bundle_sha256 = objects.name
        and (
          v.review_status = 'approved'
          or pm.has_capability(auth.uid(), 'marketplace.review', marketplace.plugin_subteam(v.plugin_id))
          or pm.has_capability(auth.uid(), 'marketplace.publish', marketplace.plugin_subteam(v.plugin_id))
        )
    )
  );

-- Untouched by design: support.reports + the report-attachments bucket (a
-- signed-in user filing a bug report about being locked out is legitimate,
-- and reads are already reporter-or-admin scoped).
