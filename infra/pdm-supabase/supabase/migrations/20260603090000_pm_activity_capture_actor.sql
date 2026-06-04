-- Record WHO performed each task change in the activity feed. The trigger took
-- actor_id from tasks.created_by/updated_by, which the app never populates, so
-- every activity row had actor_id = NULL and the feed rendered "System" for
-- everything. auth.uid() is the authenticated caller even inside this SECURITY
-- DEFINER trigger (it reads the JWT, not the executing role), so coalesce onto
-- it to capture the real actor (still honoring an explicit created_by/updated_by
-- when one is set). Applied to dlmyixonuyckxkknolku via MCP; repo kept in sync.
create or replace function pm.on_task_change()
returns trigger
language plpgsql
security definer
set search_path to 'pm', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids)
      values (new.project_id, coalesce(new.created_by, auth.uid()), 'created', 'task', new.id, new.title, array[new.subteam_id]);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids, payload)
        values (
          new.project_id, coalesce(new.updated_by, auth.uid()),
          case when new.status = 'done' then 'completed'::pm.activity_action else 'status_changed'::pm.activity_action end,
          'task', new.id, new.title, array[new.subteam_id],
          jsonb_build_object('from', old.status, 'to', new.status)
        );
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids)
      values (old.project_id, coalesce(old.updated_by, auth.uid()), 'deleted', 'task', old.id, old.title, array[old.subteam_id]);
    return old;
  end if;
  return null;
end;
$$;
