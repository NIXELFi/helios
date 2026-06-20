-- Auto-provision a vault role on signup (root-cause fix).
--
-- Problem: a new auth.users row does NOT get a pdm.user_roles row. Vault access
-- is gated entirely through pdm.user_roles (pdm.is_member_in / is_admin / can_edit_in
-- all return false when no row exists), so every new signup landed with ZERO vault
-- access and there was no automated path to a role. New members were silently
-- locked out until an admin hand-granted them a row.
--
-- Fix: a trigger on auth.users that grants every new account the baseline
-- 'editor' global role (vault_id IS NULL). This unblocks new members immediately
-- while keeping the principle of least privilege:
--   * We deliberately do NOT auto-grant 'admin'/'owner'. The signup 'subteam'
--     lives in user-controlled raw_user_meta_data, so promoting on it would let
--     anyone self-select "President"/"COO" and escalate. Officers and subteam
--     leads are promoted to 'admin' by an existing admin via the Role Editor.
--   * 'editor' (not 'viewer') is the default because this is a single-team tool
--     where members are expected to check files in/out; matches the prevailing
--     role distribution.
--
-- Idempotent: ON CONFLICT DO NOTHING against user_roles_user_vault_uniq, so it is
-- safe to re-run and never overwrites a curated role (e.g. the admins backfilled
-- by hand). The trigger swallows errors so a provisioning hiccup can never block
-- account creation.

-- 1. Trigger function: grant the new user a baseline global 'editor' role.
create or replace function pdm.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  insert into pdm.user_roles (user_id, vault_id, role, granted_at)
  values (new.id, null, 'editor', now())
  on conflict (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do nothing;
  return new;
exception
  when others then
    -- Never block signup on a provisioning failure; surface it in the logs.
    raise warning 'pdm.handle_new_user: failed to provision role for % : %', new.id, sqlerrm;
    return new;
end;
$$;

-- 2. Fire after each new auth user is created.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function pdm.handle_new_user();

-- 3. One-time backfill: grant baseline 'editor' to every existing account that
--    has no role row at all. Idempotent (ON CONFLICT DO NOTHING) so it leaves
--    curated roles -- including admins/owners and the manually-backfilled
--    officer/lead admins -- untouched.
insert into pdm.user_roles (user_id, vault_id, role, granted_at)
select u.id, null, 'editor', now()
from auth.users u
where not exists (
  select 1 from pdm.user_roles r where r.user_id = u.id
)
on conflict (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid))
do nothing;
