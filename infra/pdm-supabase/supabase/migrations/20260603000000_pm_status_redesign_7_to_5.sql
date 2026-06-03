-- PM task status redesign: collapse the 7-value status enum to 5.
--   backlog                          -> not_started
--   designing/manufacturing/testing  -> in_progress
--   needs_review/blocked/done        -> unchanged
-- Applied to the hosted dev project (dlmyixonuyckxkknolku) via MCP apply_migration.
-- The old per-row status is snapshotted to pm.tasks_status_backup first so the
-- collapse is recoverable even though the 3 dropped enum labels are gone.

create table if not exists pm.tasks_status_backup as
  select id as task_id, status::text as old_status, now() as backed_up_at
  from pm.tasks;

create type pm.task_status_new as enum ('not_started', 'in_progress', 'needs_review', 'blocked', 'done');

alter table pm.tasks alter column status drop default;
alter table pm.tasks
  alter column status type pm.task_status_new
  using (
    case status::text
      when 'backlog' then 'not_started'
      when 'designing' then 'in_progress'
      when 'manufacturing' then 'in_progress'
      when 'testing' then 'in_progress'
      else status::text
    end
  )::pm.task_status_new;
alter table pm.tasks alter column status set default 'not_started'::pm.task_status_new;

drop type pm.task_status;
alter type pm.task_status_new rename to task_status;

-- Recreate the two functions that referenced the dropped values.
create or replace function pm.clone_project_as_template(source_id uuid, new_name text, new_car_year integer, new_car_code text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'pm', 'public'
as $function$
declare
  new_project_id uuid;
  source_ship_date date;
begin
  if pm.user_role_in_project(auth.uid(), source_id) <> 'admin' then
    raise exception 'only project admins can clone';
  end if;

  select ship_date into source_ship_date from pm.projects where id = source_id;

  insert into pm.projects (name, car_year, car_code, status, template_source_id, ship_date, created_by)
    values (new_name, new_car_year, new_car_code, 'active', source_id,
            (source_ship_date + interval '1 year')::date, auth.uid())
    returning id into new_project_id;

  create temp table _t_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  insert into _t_map (old_id, new_id)
    select id, gen_random_uuid() from pm.tasks where project_id = source_id;

  insert into pm.tasks (
    id, project_id, subteam_id, subsystem_id, parent_task_id, title, description,
    type, status, priority, start_date, due_date, estimate_days, mrl, created_by
  )
    select
      tm.new_id, new_project_id, t.subteam_id, t.subsystem_id,
      (select new_id from _t_map where old_id = t.parent_task_id),
      t.title, t.description, t.type, 'not_started'::pm.task_status, t.priority,
      (t.start_date + interval '1 year')::date, (t.due_date + interval '1 year')::date,
      t.estimate_days, t.mrl, auth.uid()
    from pm.tasks t join _t_map tm on tm.old_id = t.id
    where t.project_id = source_id;

  insert into pm.task_dependencies (predecessor_id, successor_id, dep_type, lag_days)
    select
      (select new_id from _t_map where old_id = d.predecessor_id),
      (select new_id from _t_map where old_id = d.successor_id),
      d.dep_type, d.lag_days
    from pm.task_dependencies d
    where d.predecessor_id in (select old_id from _t_map);

  create temp table _m_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  insert into _m_map (old_id, new_id)
    select id, gen_random_uuid() from pm.milestones where project_id = source_id;

  insert into pm.milestones (id, project_id, name, target_date, type, description)
    select mm.new_id, new_project_id, m.name, (m.target_date + interval '1 year')::date, m.type, m.description
    from pm.milestones m join _m_map mm on mm.old_id = m.id;

  insert into pm.task_milestones (task_id, milestone_id)
    select (select new_id from _t_map where old_id = tm.task_id),
           (select new_id from _m_map where old_id = tm.milestone_id)
    from pm.task_milestones tm
    where tm.task_id in (select old_id from _t_map);

  insert into pm.team_memberships (user_id, project_id, team_role)
    values (auth.uid(), new_project_id, 'admin');

  return new_project_id;
end;
$function$;

create or replace function pm.on_vault_revision_bump(p_part_id uuid, p_rev text, p_actor uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'pm', 'public'
as $function$
begin
  update pm.tasks
    set status = 'needs_review',
        review_reason = format('Rev %s bumped on part %s', p_rev, p_part_id),
        updated_at = now()
  where id in (
    select task_id from pm.task_part_link
    where part_id = p_part_id and link_type in ('designs', 'reviews')
  )
  and status in ('done', 'in_progress');

  insert into pm.activity (project_id, actor_id, action, target_type, target_id, target_name, subteam_ids, payload)
    select t.project_id, p_actor, 'reviewed', 'task', t.id, t.title, array[t.subteam_id],
           jsonb_build_object('reason', 'auto-flag from rev bump', 'rev', p_rev, 'part_id', p_part_id)
    from pm.tasks t
    where id in (
      select task_id from pm.task_part_link
      where part_id = p_part_id and link_type in ('designs', 'reviews')
    );
end;
$function$;
