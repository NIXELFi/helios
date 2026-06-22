-- C-3 security fix: pdm.is_admin() lacks a vault_id filter, so a legitimate
-- PER-VAULT admin (role='admin', vault_id=<X>, mintable by an owner via
-- set_user_role) satisfies every gate that calls is_admin() with no scope:
--   * admin_delete_user  — irreversibly delete ANY non-admin user org-wide
--   * admin_update_user  — overwrite any non-admin user's display_name/subteam
--   * admin_list_users   — read the entire org user list + emails (cross-vault PII)
--   * list_vault_roles   — leak emails/roles of vaults they have no role in
--
-- The team already recognized this class as M6 and inlined a `vault_id IS NULL`
-- predicate for audit_log in 20260619000400, but never back-ported it to these
-- four functions. This migration introduces pdm.is_global_admin() (the missing
-- helper) and rewires the four gates:
--   * admin_delete_user / admin_update_user / admin_list_users → require
--     is_global_admin() (a per-vault admin must be rejected outright).
--   * list_vault_roles → change ONLY the first disjunct to is_global_admin();
--     the second disjunct stays is_admin_in(p_vault_id) so a per-vault admin
--     still sees THEIR OWN vault (just not others / the global list).
--
-- CREATE OR REPLACE only; bodies otherwise identical to their current source
-- migrations. Idempotent.

-- ---------------------------------------------------------------------------
-- 1. pdm.is_global_admin(): an owner/admin whose grant is GLOBAL (vault_id IS
--    NULL). A per-vault admin row does NOT satisfy this.
-- ---------------------------------------------------------------------------
create or replace function pdm.is_global_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid()
      and role in ('owner', 'admin')
      and vault_id is null
  );
$$;
grant execute on function pdm.is_global_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. admin_delete_user — global-admin gate (body otherwise verbatim from
--    20260618000100_pdm_admin_delete_user_new_fks.sql).
-- ---------------------------------------------------------------------------
create or replace function pdm.admin_delete_user(p_target uuid)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth', 'pm', 'support'
as $$
declare v_caller uuid := auth.uid(); v_role text;
begin
  if not pdm.is_global_admin() then raise exception 'not authorized'; end if;
  if p_target is null then raise exception 'target required'; end if;
  if p_target = v_caller then raise exception 'cannot delete your own account'; end if;
  select role into v_role from pdm.user_roles where user_id = p_target and vault_id is null;
  if v_role = 'owner' then raise exception 'the owner account cannot be deleted here'; end if;
  if v_role = 'admin' and not pdm.is_owner() then
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

  delete from pdm.user_roles where user_id = p_target;
  delete from auth.users where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_update_user — global-admin gate (body otherwise verbatim from
--    20260619000100_pdm_admin_update_user_owner_guard.sql).
-- ---------------------------------------------------------------------------
create or replace function pdm.admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth'
as $$
declare
  v_target_role text;
begin
  if not pdm.is_global_admin() then raise exception 'not authorized'; end if;
  if p_target is null then raise exception 'target required'; end if;

  -- Owner-account guard: only the owner may edit the owner account.
  select role into v_target_role
    from pdm.user_roles
   where user_id = p_target and vault_id is null;
  if v_target_role = 'owner' and not pdm.is_owner() then
    raise exception 'only the owner can edit the owner account';
  end if;
  -- Admin-tier guard (full parity with admin_delete_user): a non-owner admin
  -- cannot act on another admin's account.
  if v_target_role = 'admin' and not pdm.is_owner() then
    raise exception 'only the owner can edit an admin';
  end if;

  update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('display_name', p_display_name, 'subteam', p_subteam)
    where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. admin_list_users — global-admin gate. The 7-column signature (display_name
--    + subteam, vault_id IS NULL join) is the current one from
--    20260531000000_pdm_per_vault_roles.sql; body otherwise verbatim.
-- ---------------------------------------------------------------------------
create or replace function pdm.admin_list_users()
returns table (user_id uuid, email text, display_name text, subteam text, role text, granted_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = pdm, public, auth as $$
begin
  if not pdm.is_global_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select u.id, u.email::text,
      (u.raw_user_meta_data->>'display_name')::text,
      (u.raw_user_meta_data->>'subteam')::text,
      r.role, r.granted_at, u.created_at
    from auth.users u
    left join pdm.user_roles r on r.user_id = u.id and r.vault_id is null
    order by u.created_at asc;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. list_vault_roles — first disjunct → is_global_admin() so a per-vault admin
--    only retains their OWN vault via the is_admin_in(p_vault_id) disjunct.
--    8-column signature (display_name + subteam) is the current one from
--    20260618000900; body otherwise verbatim.
-- ---------------------------------------------------------------------------
create or replace function pdm.list_vault_roles(p_vault_id uuid)
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, scope text, granted_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = pdm, public, auth as $$
begin
  if not (pdm.is_global_admin() or pdm.is_admin_in(p_vault_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select u.id,
           u.email::text,
           (u.raw_user_meta_data->>'display_name')::text,
           (u.raw_user_meta_data->>'subteam')::text,
           coalesce(rv.role, rg.role) as role,
           case when rv.role is not null then 'vault'
                when rg.role is not null then 'global'
                else null end as scope,
           coalesce(rv.granted_at, rg.granted_at) as granted_at,
           u.created_at
    from auth.users u
    left join pdm.user_roles rv on rv.user_id = u.id and rv.vault_id = p_vault_id
    left join pdm.user_roles rg on rg.user_id = u.id and rg.vault_id is null
    order by u.created_at asc;
end; $$;
