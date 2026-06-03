-- Log task DELETEs to the activity feed. The trigger previously fired only on
-- INSERT/UPDATE, so deleted-task activity never persisted. (activity_action
-- already has 'deleted'; activity.target_id has no FK to tasks, so the row
-- survives the task being gone.)
create or replace function pm.on_task_change() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $function$
begin
  if tg_op = 'INSERT' then
    insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids)
      values (new.project_id, new.created_by, 'created', 'task', new.id, new.title, array[new.subteam_id]);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids, payload)
        values (
          new.project_id, new.updated_by,
          case when new.status = 'done' then 'completed'::pm.activity_action else 'status_changed'::pm.activity_action end,
          'task', new.id, new.title, array[new.subteam_id],
          jsonb_build_object('from', old.status, 'to', new.status)
        );
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids)
      values (old.project_id, old.updated_by, 'deleted', 'task', old.id, old.title, array[old.subteam_id]);
    return old;
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_task_activity on pm.tasks;
create trigger trg_task_activity after insert or update or delete on pm.tasks
  for each row execute function pm.on_task_change();
