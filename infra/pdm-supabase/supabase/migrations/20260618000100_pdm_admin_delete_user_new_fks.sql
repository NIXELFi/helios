-- v4.4.6 fix: pdm.admin_delete_user misses NO-ACTION FKs added after it shipped.
--
-- 20260603080000 detaches every auth.users reference before "delete from
-- auth.users", but three NO-ACTION FKs introduced later are not handled, so
-- deleting any user who ever filed a report or created a task link / task owner
-- row FK-violates and rolls the whole delete back -- a guaranteed failure on a
-- very common path:
--   * support.reports.reporter_id  (NOT NULL references auth.users)
--   * pm.task_owners.created_by     (references auth.users)
--   * pm.task_links.created_by      (references auth.users)
--
-- reporter_id is NOT NULL, so it is REASSIGNED to the deleting admin (the report
-- content is retained; only the filer attribution moves). The two created_by
-- columns are nullable, so they are nulled. CREATE OR REPLACE only -- the body
-- is otherwise identical to 20260603080000. Idempotent.

create or replace function pdm.admin_delete_user(p_target uuid)
returns void
language plpgsql
security definer
set search_path to 'pdm', 'public', 'auth', 'pm', 'support'
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
