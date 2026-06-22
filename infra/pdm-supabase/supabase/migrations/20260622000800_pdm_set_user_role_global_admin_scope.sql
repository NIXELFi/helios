-- Audit follow-up (v4 bug vault, review finding): close the C-3-class escalation
-- route-around in pdm.set_user_role / pdm.revoke_user_role.
--
-- C-3 (migration 20260622000100) scoped global-admin gates to pdm.is_global_admin()
-- in admin_delete_user / admin_update_user / admin_list_users / list_vault_roles,
-- but set_user_role / revoke_user_role were left gating a GLOBAL (vault_id IS NULL)
-- editor/viewer grant on bare pdm.is_admin(). A per-vault admin therefore still
-- passed that gate and could MINT a global editor role (vault_id NULL) for any
-- non-admin target — and can_edit_in() honors a global role in every vault, i.e.
-- the same org-wide write-escalation C-3 set out to close. (Granting global
-- admin/owner still correctly requires pdm.is_owner(), so this was escalation,
-- not full takeover — but it let a per-vault admin route around the C-3 fix.)
--
-- Fix: in the GLOBAL branch (p_vault_id IS NULL) require pdm.is_global_admin();
-- the per-vault branch keeps pdm.is_admin_in(p_vault_id) so a per-vault admin
-- retains legitimate authority over their own vault. Bodies are otherwise
-- verbatim from the latest prior definition (20260531000000).

create or replace function pdm.set_user_role(p_target uuid, p_role text, p_vault_id uuid default null)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_current text; v_zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  if v_caller is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid or disallowed role: %', p_role using errcode = '22023';
  end if;
  if p_target = v_caller then raise exception 'cannot change your own role' using errcode = '42501'; end if;

  select role into v_current from pdm.user_roles
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if v_current = 'owner' then raise exception 'the owner role cannot be modified here' using errcode = '42501'; end if;

  if p_role = 'admin' or v_current = 'admin' then
    if not pdm.is_owner() then
      raise exception 'only the owner can grant or change the admin role' using errcode = '42501';
    end if;
  else
    if not (case when p_vault_id is null then pdm.is_global_admin() else pdm.is_admin_in(p_vault_id) end) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  update pdm.user_roles set role = p_role, granted_by = v_caller, granted_at = now()
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if not found then
    insert into pdm.user_roles (user_id, vault_id, role, granted_by, granted_at)
    values (p_target, p_vault_id, p_role, v_caller, now());
  end if;
end; $$;

create or replace function pdm.revoke_user_role(p_target uuid, p_vault_id uuid default null)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_current text; v_zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  if v_caller is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_target = v_caller then raise exception 'cannot revoke your own role' using errcode = '42501'; end if;
  select role into v_current from pdm.user_roles
    where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
  if v_current is null then return; end if;
  if v_current = 'owner' then raise exception 'the owner role cannot be revoked here' using errcode = '42501'; end if;
  if v_current = 'admin' then
    if not pdm.is_owner() then raise exception 'only the owner can revoke an admin' using errcode = '42501'; end if;
  else
    if not (case when p_vault_id is null then pdm.is_global_admin() else pdm.is_admin_in(p_vault_id) end) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  delete from pdm.user_roles where user_id = p_target and coalesce(vault_id, v_zero) = coalesce(p_vault_id, v_zero);
end; $$;
