-- Admin user management from the desktop app: edit a user's profile
-- (display_name + subteam) and permanently delete an account. Both SECURITY
-- DEFINER + is_admin()-gated, mirroring pdm.set_user_role's ownership rules.
-- Guards raise with the default P0001 errcode so the client surfaces the
-- specific reason verbatim. Email is intentionally NOT editable (login identity).
--
-- Delete is the hard part: many NO-ACTION FKs across pdm + pm reference
-- auth.users, so a naive delete fails for any user who created tasks / projects
-- / vaults / locks. The function detaches every such reference first (nullable
-- refs nulled; NOT NULL vault ownership reassigned to the deleting admin; the
-- user's own locks removed) — all in one transaction, so any miss rolls the
-- whole delete back rather than leaving a half-deleted user. CASCADE / SET NULL
-- FKs (auth internals, versions.author_id, task_comments, audit_log,
-- *_memberships, user_roles.user_id) self-handle.
--
-- Applied to dlmyixonuyckxkknolku via MCP; this file keeps the repo in sync.

create or replace function pdm.admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth'
as $$
begin
  if not pdm.is_admin() then raise exception 'not authorized'; end if;
  if p_target is null then raise exception 'target required'; end if;
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
set search_path to 'pdm', 'public', 'auth', 'pm'
as $$
declare v_caller uuid := auth.uid(); v_role text;
begin
  if not pdm.is_admin() then raise exception 'not authorized'; end if;
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

  delete from pdm.user_roles where user_id = p_target;
  delete from auth.users where id = p_target;
  if not found then raise exception 'user not found'; end if;
end;
$$;

-- Thin pdm_-prefixed wrappers (the convention the desktop client's rpc() uses).
create or replace function pdm.pdm_admin_update_user(p_target uuid, p_display_name text, p_subteam text)
returns void language sql security definer set search_path to 'pdm', 'public'
as $$ select pdm.admin_update_user(p_target, p_display_name, p_subteam); $$;

create or replace function pdm.pdm_admin_delete_user(p_target uuid)
returns void language sql security definer set search_path to 'pdm', 'public'
as $$ select pdm.admin_delete_user(p_target); $$;

grant execute on function pdm.pdm_admin_update_user(uuid, text, text) to authenticated;
grant execute on function pdm.pdm_admin_delete_user(uuid) to authenticated;
