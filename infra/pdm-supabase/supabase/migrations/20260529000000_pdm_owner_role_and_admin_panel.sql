-- Admin panel backend: an "owner" role tier + role-management RPCs.
--
-- Permission model (hybrid):
--   * OWNER  — single super-user (set out-of-band via bootstrap-admin.ts).
--              Only the owner can grant / change / revoke the ADMIN role.
--   * ADMIN  — full vault powers (write, force-unlock, ...) AND can
--              grant / revoke EDITOR + VIEWER. Owner counts as admin.
--   * EDITOR / VIEWER — granted by any admin.
--
-- The 'owner' role itself is intentionally NOT assignable or revocable
-- through these RPCs — it can only be set by the service-role bootstrap
-- script. That prevents both privilege escalation (an admin minting an
-- owner) and lockout (the last owner being demoted from the UI).
--
-- DML on pdm.user_roles is revoked from `authenticated`
-- (20260511001300), so every change flows through the SECURITY DEFINER
-- functions below, which run with the definer's (postgres) rights and
-- enforce the rules in-band.

-- ---------------------------------------------------------------------------
-- 1. Allow 'owner' in the role check constraint.
-- ---------------------------------------------------------------------------
alter table pdm.user_roles drop constraint if exists user_roles_role_check;
alter table pdm.user_roles
  add constraint user_roles_role_check
  check (role in ('owner', 'admin', 'editor', 'viewer'));

-- ---------------------------------------------------------------------------
-- 2. Owner counts as admin everywhere is_admin() is consulted.
-- ---------------------------------------------------------------------------
create or replace function pdm.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. is_owner() + proxies (pdm.pdm_* for the schema=pdm JS client, public.* too).
-- ---------------------------------------------------------------------------
create or replace function pdm.is_owner()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role = 'owner'
  );
$$;

create or replace function pdm.pdm_is_owner()
returns boolean
language sql stable security definer
set search_path = pdm, public
as $$ select pdm.is_owner(); $$;
grant execute on function pdm.pdm_is_owner() to authenticated;

create or replace function public.pdm_is_owner()
returns boolean
language sql stable security definer
set search_path = pdm, public
as $$ select pdm.is_owner(); $$;
grant execute on function public.pdm_is_owner() to authenticated;
revoke execute on function public.pdm_is_owner() from anon;

-- ---------------------------------------------------------------------------
-- 4. admin_list_users() — every auth user + their role. Admin-gated so the
--    panel can show real emails (auth.users isn't client-readable).
-- ---------------------------------------------------------------------------
create or replace function pdm.admin_list_users()
returns table (
  user_id uuid,
  email text,
  role text,
  granted_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pdm, public, auth
as $$
begin
  if not pdm.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, r.role, r.granted_at, u.created_at
    from auth.users u
    left join pdm.user_roles r on r.user_id = u.id
    order by u.created_at asc;
end;
$$;

create or replace function pdm.pdm_admin_list_users()
returns table (
  user_id uuid, email text, role text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = pdm, public
as $$ select * from pdm.admin_list_users(); $$;
grant execute on function pdm.pdm_admin_list_users() to authenticated;

create or replace function public.pdm_admin_list_users()
returns table (
  user_id uuid, email text, role text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = pdm, public
as $$ select * from pdm.admin_list_users(); $$;
grant execute on function public.pdm_admin_list_users() to authenticated;
revoke execute on function public.pdm_admin_list_users() from anon;

-- ---------------------------------------------------------------------------
-- 5. set_user_role(target, role) — grant / change a role with hybrid auth.
-- ---------------------------------------------------------------------------
create or replace function pdm.set_user_role(p_target uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_current text;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- 'owner' is never assignable here (bootstrap-only). Reject anything else
  -- outside the editable set.
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid or disallowed role: %', p_role using errcode = '22023';
  end if;
  if p_target = v_caller then
    raise exception 'cannot change your own role' using errcode = '42501';
  end if;

  select role into v_current from pdm.user_roles where user_id = p_target;

  -- The owner row is immutable through this RPC.
  if v_current = 'owner' then
    raise exception 'the owner role cannot be modified here' using errcode = '42501';
  end if;

  -- Granting admin OR touching an existing admin requires owner; otherwise
  -- (editor/viewer on a non-admin row) any admin will do.
  if p_role = 'admin' or v_current = 'admin' then
    if not pdm.is_owner() then
      raise exception 'only the owner can grant or change the admin role' using errcode = '42501';
    end if;
  else
    if not pdm.is_admin() then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  insert into pdm.user_roles (user_id, role, granted_by, granted_at)
  values (p_target, p_role, v_caller, now())
  on conflict (user_id) do update
    set role = excluded.role, granted_by = v_caller, granted_at = now();
end;
$$;

create or replace function pdm.pdm_set_user_role(p_target uuid, p_role text)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.set_user_role(p_target, p_role); $$;
grant execute on function pdm.pdm_set_user_role(uuid, text) to authenticated;

create or replace function public.pdm_set_user_role(p_target uuid, p_role text)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.set_user_role(p_target, p_role); $$;
grant execute on function public.pdm_set_user_role(uuid, text) to authenticated;
revoke execute on function public.pdm_set_user_role(uuid, text) from anon;

-- ---------------------------------------------------------------------------
-- 6. revoke_user_role(target) — remove a user's role entirely (no access).
-- ---------------------------------------------------------------------------
create or replace function pdm.revoke_user_role(p_target uuid)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_current text;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_target = v_caller then
    raise exception 'cannot revoke your own role' using errcode = '42501';
  end if;

  select role into v_current from pdm.user_roles where user_id = p_target;
  if v_current is null then
    return; -- nothing to revoke
  end if;
  if v_current = 'owner' then
    raise exception 'the owner role cannot be revoked here' using errcode = '42501';
  end if;
  if v_current = 'admin' then
    if not pdm.is_owner() then
      raise exception 'only the owner can revoke an admin' using errcode = '42501';
    end if;
  else
    if not pdm.is_admin() then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  delete from pdm.user_roles where user_id = p_target;
end;
$$;

create or replace function pdm.pdm_revoke_user_role(p_target uuid)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.revoke_user_role(p_target); $$;
grant execute on function pdm.pdm_revoke_user_role(uuid) to authenticated;

create or replace function public.pdm_revoke_user_role(p_target uuid)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.revoke_user_role(p_target); $$;
grant execute on function public.pdm_revoke_user_role(uuid) to authenticated;
revoke execute on function public.pdm_revoke_user_role(uuid) from anon;
