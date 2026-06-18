-- v4.4.6 fix: tasks.owner_id -> task_owners sync can leave two is_primary rows.
--
-- sync_owner_to_task_owners (20260617012000) only demotes/removes the prior
-- primary on the UPDATE path where old.owner_id changed (and is non-null). On a
-- task INSERT with an owner, or any write where a DIFFERENT user already holds
-- is_primary for the task (e.g. a co-owner promoted via set_task_primary_owner,
-- then a scalar owner_id write), the function promotes the new owner without
-- demoting the existing primary -- briefly two is_primary rows, which the
-- unique partial index then rejects, or drifts under nested writes.
--
-- Fix: ALWAYS demote any existing primary for the task (other than the incoming
-- owner) before promoting the new one, regardless of the old.owner_id path.
-- CREATE OR REPLACE only. Idempotent.

create or replace function pm.sync_owner_to_task_owners() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  if new.owner_id is not null then
    -- Demote any current primary for this task that isn't the incoming owner,
    -- so promoting the new one can never produce a second is_primary row.
    update pm.task_owners
      set is_primary = false
      where task_id = new.id and is_primary and owner_id <> new.owner_id;
    insert into pm.task_owners (task_id, owner_id, is_primary)
      values (new.id, new.owner_id, true)
      on conflict (task_id, owner_id) do update set is_primary = true;
  elsif tg_op = 'UPDATE' and old.owner_id is not null then
    -- Owner cleared: drop the prior primary membership (familiar "clear the
    -- owner" semantics); co-owner rows (is_primary=false) are left untouched.
    delete from pm.task_owners where task_id = new.id and owner_id = old.owner_id and is_primary;
  end if;
  return null;
end; $$;
