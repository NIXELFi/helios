-- Helper: is the calling user a pdm admin?
create or replace function pdm.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$
  select exists (
    select 1 from pdm.user_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- Expose as a top-level callable RPC for tests / clients (PostgREST exposes
-- public-schema functions; we proxy to pdm.is_admin()).
create or replace function public.pdm_is_admin()
returns boolean
language sql
stable
security definer
set search_path = pdm, public
as $$ select pdm.is_admin(); $$;

grant execute on function public.pdm_is_admin() to authenticated;

-- RLS for pdm.user_roles
alter table pdm.user_roles enable row level security;

-- Read: any authenticated user can read every row (single-team app).
create policy user_roles_read on pdm.user_roles
  for select to authenticated
  using (true);

-- Insert / update / delete: admin only.
create policy user_roles_insert_admin on pdm.user_roles
  for insert to authenticated
  with check (pdm.is_admin());

create policy user_roles_update_admin on pdm.user_roles
  for update to authenticated
  using (pdm.is_admin())
  with check (pdm.is_admin());

create policy user_roles_delete_admin on pdm.user_roles
  for delete to authenticated
  using (pdm.is_admin());
