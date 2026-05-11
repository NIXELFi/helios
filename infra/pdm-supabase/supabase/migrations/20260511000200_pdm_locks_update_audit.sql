-- Fix H3 from ultrareview 2026-05-11:
-- 20260507000900_pdm_audit_triggers.sql installed locks_audit_insert (AFTER
-- INSERT) but nothing fires on the corresponding "lock released" transition.
-- pdm.cancel_checkout and pdm.force_unlock SECURITY DEFINER RPCs write their
-- own audit rows, but a direct UPDATE that sets released_at (e.g. via service
-- role or future code paths) leaves no trace.
--
-- This migration adds an AFTER UPDATE trigger that fires only on the
-- "released_at goes from NULL to non-NULL" transition and writes an audit row
-- with action='lock_released'.

create or replace function pdm.trg_locks_audit_update() returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  if OLD.released_at is null and NEW.released_at is not null then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (
      NEW.user_id,
      'lock_released',
      'lock',
      NEW.id,
      jsonb_build_object(
        'user', NEW.user_id,
        'force_released_by', NEW.force_released_by,
        'file_id', NEW.file_id
      )
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists locks_audit_update on pdm.locks;
create trigger locks_audit_update
  after update on pdm.locks
  for each row execute function pdm.trg_locks_audit_update();
