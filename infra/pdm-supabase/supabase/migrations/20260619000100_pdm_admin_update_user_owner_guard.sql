-- H10 security fix: pdm.admin_update_user must reject non-owner admins from
-- editing the owner account, mirroring the guard already in admin_delete_user
-- (20260603080000_pdm_admin_user_edit_delete.sql).
--
-- Before this fix a global admin could call admin_update_user on the owner's
-- user_id and overwrite display_name / subteam without restriction. The fix
-- looks up the target's GLOBAL role and raises if it is 'owner' and the caller
-- is not pdm.is_owner().
--
-- This is a verbatim copy of the 20260603080000 body with one guard block added
-- immediately after the existing is_admin() check. The wrapper function and
-- grants already exist and are idempotent here. Applies to production via
-- CREATE OR REPLACE.

create or replace function pdm.admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth'
as $$
declare
  v_target_role text;
begin
  if not pdm.is_admin() then raise exception 'not authorized'; end if;
  if p_target is null then raise exception 'target required'; end if;

  -- Owner-account guard: only the owner may edit the owner account.
  select role into v_target_role
    from pdm.user_roles
   where user_id = p_target and vault_id is null;
  if v_target_role = 'owner' and not pdm.is_owner() then
    raise exception 'only the owner can edit the owner account';
  end if;

  update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('display_name', p_display_name, 'subteam', p_subteam)
    where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;

-- Thin wrapper re-created to stay consistent; idempotent.
create or replace function pdm.pdm_admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void language sql security definer set search_path to 'pdm', 'public'
as $$ select pdm.admin_update_user(p_target, p_display_name, p_subteam); $$;

grant execute on function pdm.pdm_admin_update_user(uuid, text, text) to authenticated;
