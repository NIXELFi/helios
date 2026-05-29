-- Subteams: a managed list of SDM subteams every account must pick at sign-up.
-- The list lives here (not hard-coded in the app) so owner/admins can add more.
-- A user's chosen subteam + display name are stored in auth.users metadata at
-- sign-up (see the app's signUp call); this table is the source for the picker
-- and for admin management.

create table pdm.subteams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Preserve the team's preferred (non-alphabetical) ordering in the picker.
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- Seed the initial subteams in the requested order (NOT alphabetical).
insert into pdm.subteams (name, sort_order) values
  ('Engine', 1),
  ('Suspension', 2),
  ('Driver Interface', 3),
  ('Drivetrain', 4),
  ('Brakes', 5),
  ('Chassis', 6),
  ('Aero Design', 7),
  ('Aero Manufacturing', 8),
  ('Operations', 9),
  ('Finance', 10),
  ('MarCom', 11)
on conflict (name) do nothing;

-- RLS: the list must be readable BEFORE auth (the sign-up form shows it while
-- the user is still anonymous), so select is open to anon + authenticated.
-- The names aren't sensitive. Writes go through the admin RPCs below.
alter table pdm.subteams enable row level security;

create policy subteams_read on pdm.subteams
  for select to anon, authenticated
  using (true);

grant select on pdm.subteams to anon, authenticated;
-- No direct DML for clients; creation/removal is admin-gated via RPC.
revoke insert, update, delete on pdm.subteams from anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_subteam / delete_subteam — admin (incl. owner) only.
-- ---------------------------------------------------------------------------
create or replace function pdm.create_subteam(p_name text)
returns pdm.subteams
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_row pdm.subteams;
  v_next int;
begin
  if not pdm.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'subteam name is required' using errcode = '22023';
  end if;
  select coalesce(max(sort_order), 0) + 1 into v_next from pdm.subteams;
  insert into pdm.subteams (name, sort_order, created_by)
  values (btrim(p_name), v_next, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function pdm.delete_subteam(p_id uuid)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  if not pdm.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from pdm.subteams where id = p_id;
end;
$$;

-- Proxies: pdm.pdm_* (the JS client uses db.schema = 'pdm') + public.pdm_*.
create or replace function pdm.pdm_create_subteam(p_name text)
returns pdm.subteams language sql security definer
set search_path = pdm, public
as $$ select pdm.create_subteam(p_name); $$;
grant execute on function pdm.pdm_create_subteam(text) to authenticated;

create or replace function public.pdm_create_subteam(p_name text)
returns pdm.subteams language sql security definer
set search_path = pdm, public
as $$ select pdm.create_subteam(p_name); $$;
grant execute on function public.pdm_create_subteam(text) to authenticated;
revoke execute on function public.pdm_create_subteam(text) from anon;

create or replace function pdm.pdm_delete_subteam(p_id uuid)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.delete_subteam(p_id); $$;
grant execute on function pdm.pdm_delete_subteam(uuid) to authenticated;

create or replace function public.pdm_delete_subteam(p_id uuid)
returns void language sql security definer
set search_path = pdm, public
as $$ select pdm.delete_subteam(p_id); $$;
grant execute on function public.pdm_delete_subteam(uuid) to authenticated;
revoke execute on function public.pdm_delete_subteam(uuid) from anon;

-- ---------------------------------------------------------------------------
-- Extend admin_list_users() to surface display_name + subteam (from
-- auth.users metadata). Return type changes, so drop + recreate the trio.
-- ---------------------------------------------------------------------------
drop function if exists public.pdm_admin_list_users();
drop function if exists pdm.pdm_admin_list_users();
drop function if exists pdm.admin_list_users();

create function pdm.admin_list_users()
returns table (
  user_id uuid,
  email text,
  display_name text,
  subteam text,
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
    select
      u.id,
      u.email::text,
      (u.raw_user_meta_data->>'display_name')::text,
      (u.raw_user_meta_data->>'subteam')::text,
      r.role,
      r.granted_at,
      u.created_at
    from auth.users u
    left join pdm.user_roles r on r.user_id = u.id
    order by u.created_at asc;
end;
$$;

create function pdm.pdm_admin_list_users()
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = pdm, public
as $$ select * from pdm.admin_list_users(); $$;
grant execute on function pdm.pdm_admin_list_users() to authenticated;

create function public.pdm_admin_list_users()
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = pdm, public
as $$ select * from pdm.admin_list_users(); $$;
grant execute on function public.pdm_admin_list_users() to authenticated;
revoke execute on function public.pdm_admin_list_users() from anon;
