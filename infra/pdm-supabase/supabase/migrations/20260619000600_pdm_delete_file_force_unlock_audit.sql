-- Audit-trail gap fix: pdm.delete_file force-unlock attribution.
--
-- When an admin deletes a file that is checked out (locked) by ANOTHER user,
-- the previous implementation silently released the lock with no
-- force_released_by attribution and no audit entry naming the displaced holder.
-- This mirrors the pattern already used in pdm.force_unlock (20260531000000):
--   • Set force_released_by = caller on the displaced lock rows.
--   • Insert an audit_log row per displaced holder
--     (action='force_unlock', target_type='lock', payload includes via +
--      displaced_holder) so the event is visible in vault activity history.
-- A user deleting their OWN checked-out file is unaffected: force_released_by
-- stays NULL and no force_unlock audit row is written, exactly as before.

CREATE OR REPLACE FUNCTION pdm.delete_file(p_file_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pdm', 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_vault  uuid;
  -- row type for capturing displaced locks
  v_lock   record;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not ((exists (select 1 from pdm.locks where file_id = p_file_id and user_id = v_caller and released_at is null)
           and pdm.can_edit_in(v_vault))
          or pdm.is_admin_in(v_vault)) then
    raise exception 'check the file out (or be an admin) to delete it';
  end if;

  -- Capture any active locks held by OTHER users before releasing them so we
  -- can write force-unlock attribution and audit rows below.
  for v_lock in
    select id, user_id
    from pdm.locks
    where file_id = p_file_id
      and released_at is null
      and user_id <> v_caller
  loop
    -- Mirror pdm.force_unlock: stamp force_released_by on the displaced lock.
    update pdm.locks
       set released_at       = now(),
           force_released_by = v_caller
     where id = v_lock.id;

    -- Write a force_unlock audit entry for the displaced holder, swallowed so
    -- logging failure can never abort the delete.
    begin
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
        values (
          v_caller,
          'force_unlock',
          'lock',
          v_lock.id,
          jsonb_build_object(
            'via',               'delete_file',
            'file_id',           p_file_id,
            'displaced_holder',  v_lock.user_id
          )
        );
    exception when others then null; end;
  end loop;

  -- Soft-delete the file row.
  update pdm.files set deleted_at = now(), deleted_by = v_caller where id = p_file_id and deleted_at is null;

  -- Release any remaining active locks (i.e. the caller's own lock, if any).
  update pdm.locks set released_at = now() where file_id = p_file_id and released_at is null;

  -- Existing delete audit row — unchanged.
  begin
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'delete', 'file', p_file_id, jsonb_build_object('soft', true));
  exception when others then null; end;
end; $function$;
