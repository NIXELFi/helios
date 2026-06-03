-- Reverse sync for the task_subteams join table. A DIRECT change to
-- pm.tasks.subteam_id (a single-task subteam move via updateTask, or a bulk
-- "move to team" via batchPatchTasks) must re-home the primary membership in
-- pm.task_subteams. Without this, those existing direct-write paths leave the
-- join table stale (the move reverts on the next loadWorkspace).
--
-- Semantics match the optimistic client (embedTaskPatch): the previous primary
-- membership is REPLACED (dropped); any secondary memberships are kept; the new
-- subteam is added as primary. The pg_trigger_depth() = 1 guard ensures this
-- only fires for top-level direct updates, never when the forward sync trigger
-- (task_subteams -> tasks.subteam_id) is what changed subteam_id — which would
-- otherwise recurse.
create or replace function pm.sync_subteam_id_to_memberships() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  if pg_trigger_depth() <> 1 then
    return null;
  end if;
  if new.subteam_id is distinct from old.subteam_id then
    delete from pm.task_subteams where task_id = new.id and subteam_id = old.subteam_id;
    update pm.task_subteams set is_primary = false
      where task_id = new.id and is_primary and subteam_id <> new.subteam_id;
    insert into pm.task_subteams (task_id, subteam_id, is_primary)
      values (new.id, new.subteam_id, true)
      on conflict (task_id, subteam_id) do update set is_primary = true;
  end if;
  return null;
end; $$;
create trigger trg_tasks_sync_subteam_to_memberships
  after update of subteam_id on pm.tasks
  for each row execute function pm.sync_subteam_id_to_memberships();
