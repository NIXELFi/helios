-- Org-capability bridge for the pdm admin user RPCs (audit M1 follow-through).
--
-- pdm.admin_update_user / pdm.admin_delete_user still gate purely on LEGACY
-- global pdm.user_roles rows (is_global_admin / is_owner). Their only UI now
-- lives in the Org & Access module (the orphaned vault AdminScreen is removed
-- in the same change), and Org & Access admins are CAPABILITY holders — many
-- have no legacy row at all, so profile edits / account deletes would raise
-- 'not authorized' for exactly the people the module says may do them.
--
-- Bridge, following the 20260714000000/30000/40000 pattern (additive OR;
-- legacy behavior untouched):
--   * caller gate: pdm.is_global_admin() OR an ORG-scoped org.grant_roles
--     capability — the same predicate pm.org_team_role maps to 'admin' and the
--     People & Roles UI already gates its edit affordances on.
--   * admin-tier target protection: a target who is a legacy global
--     owner/admin OR holds org-scoped org.grant_roles / org.manage_admins may
--     only be edited/deleted by THE legacy owner. This keeps (and extends to
--     the capability world) the standing invariant that peers can't act on
--     peers: capability admins manage regular members; admin-tier accounts
--     stay owner-managed. Note this deliberately TIGHTENS one legacy edge — a
--     capability-only admin target used to look like a plain member to these
--     guards and was editable by any legacy global admin.
--
-- Bodies otherwise verbatim from 20260622000100_pdm_is_global_admin.sql, plus
-- one repair: delete's FK-detach list predates the marketplace schema
-- (20260626000000), whose plugins.created_by / plugin_versions.published_by
-- are NOT NULL references to auth.users — deleting any plugin author failed
-- outright on the FK. Detached below like the pdm.vaults convention.
-- The pdm_-prefixed wrappers delegate and need no recreation.

create or replace function pdm.admin_is_admin_tier(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = pdm, pm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = p_user and role in ('owner', 'admin') and vault_id is null
  )
  or pm.has_capability(p_user, 'org.grant_roles', null)
  or pm.has_capability(p_user, 'org.manage_admins', null);
$$;
-- No client grant: only the definer admin RPCs below call it (they execute as
-- the function owner). A PUBLIC/authenticated grant would let any member probe
-- whether an arbitrary uid is admin-tier.
revoke all on function pdm.admin_is_admin_tier(uuid) from public, anon, authenticated;

create or replace function pdm.admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth'
as $$
declare
  v_target_role text;
begin
  if not (pdm.is_global_admin() or pm.has_capability(auth.uid(), 'org.grant_roles', null)) then
    raise exception 'not authorized';
  end if;
  if p_target is null then raise exception 'target required'; end if;

  -- Owner-account guard: only the owner may edit the owner account.
  select role into v_target_role
    from pdm.user_roles
   where user_id = p_target and vault_id is null;
  if v_target_role = 'owner' and not pdm.is_owner() then
    raise exception 'only the owner can edit the owner account';
  end if;
  -- Admin-tier guard (legacy admin OR capability admin): owner only.
  if pdm.admin_is_admin_tier(p_target) and not pdm.is_owner() then
    raise exception 'only the owner can edit an admin';
  end if;

  update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('display_name', p_display_name, 'subteam', p_subteam)
    where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;

create or replace function pdm.admin_delete_user(p_target uuid)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth', 'pm', 'support'
as $$
declare v_caller uuid := auth.uid(); v_role text;
begin
  if not (pdm.is_global_admin() or pm.has_capability(v_caller, 'org.grant_roles', null)) then
    raise exception 'not authorized';
  end if;
  if p_target is null then raise exception 'target required'; end if;
  if p_target = v_caller then raise exception 'cannot delete your own account'; end if;
  select role into v_role from pdm.user_roles where user_id = p_target and vault_id is null;
  if v_role = 'owner' then raise exception 'the owner account cannot be deleted here'; end if;
  if pdm.admin_is_admin_tier(p_target) and not pdm.is_owner() then
    raise exception 'only the owner can delete an admin';
  end if;

  delete from pdm.locks where user_id = p_target;
  update pdm.locks      set force_released_by = null where force_released_by = p_target;
  update pdm.subteams   set created_by = null        where created_by = p_target;
  update pdm.user_roles set granted_by = null        where granted_by = p_target;
  update pdm.vaults     set created_by = v_caller     where created_by = p_target;

  update pm.activity        set actor_id = null   where actor_id = p_target;
  update pm.calendar_events set created_by = null where created_by = p_target;
  update pm.database_views  set owner_id = null   where owner_id = p_target;
  update pm.pages           set created_by = null where created_by = p_target;
  update pm.projects        set created_by = null where created_by = p_target;
  update pm.subteams        set created_by = null where created_by = p_target;
  update pm.task_part_link  set created_by = null where created_by = p_target;
  update pm.tasks           set created_by = null where created_by = p_target;
  update pm.tasks           set owner_id = null   where owner_id = p_target;
  update pm.tasks           set updated_by = null where updated_by = p_target;

  -- Newer NO-ACTION FKs (added after 20260603080000). reporter_id is NOT NULL,
  -- so reassign the report to the deleting admin; the two created_by columns
  -- are nullable, so null them.
  update support.reports    set reporter_id = v_caller where reporter_id = p_target;
  update pm.task_owners     set created_by = null      where created_by = p_target;
  update pm.task_links      set created_by = null      where created_by = p_target;

  -- Marketplace FKs (20260626000000), missed by every body since then:
  -- plugins.created_by and plugin_versions.published_by are NOT NULL, so
  -- reassign to the deleting admin (the pdm.vaults convention); reviewed_by is
  -- nullable; plugin_installs cascades on its own.
  update marketplace.plugins         set created_by   = v_caller where created_by   = p_target;
  update marketplace.plugin_versions set published_by = v_caller where published_by = p_target;
  update marketplace.plugin_versions set reviewed_by  = null     where reviewed_by  = p_target;

  -- storage.objects.owner is a deprecated informational column that has
  -- carried an auth.users FK on some stack versions (the vault sets it on
  -- every upload). Null it defensively, tolerating stacks where the column,
  -- FK, or our permission on it differs.
  begin
    update storage.objects set owner = null where owner = p_target;
  exception when others then null; end;

  delete from pdm.user_roles where user_id = p_target;
  delete from auth.users where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;
