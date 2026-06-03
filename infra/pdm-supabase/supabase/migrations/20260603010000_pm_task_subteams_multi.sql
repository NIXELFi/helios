-- Multiple subteams per task with exactly one primary. pm.tasks.subteam_id is
-- KEPT as the denormalized primary mirror (synced by trigger) so RLS
-- (can_edit_task/effective_role), the activity trigger, clone, and every
-- existing single-subteam read keep working unchanged. Applied to the hosted
-- dev project (dlmyixonuyckxkknolku) via MCP apply_migration.
create table pm.task_subteams (
  task_id uuid not null references pm.tasks(id) on delete cascade,
  subteam_id uuid not null references pm.subteams(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (task_id, subteam_id)
);
create unique index task_subteams_one_primary on pm.task_subteams (task_id) where is_primary;
create index task_subteams_subteam_idx on pm.task_subteams (subteam_id);

insert into pm.task_subteams (task_id, subteam_id, is_primary)
  select id, subteam_id, true from pm.tasks
  on conflict (task_id, subteam_id) do nothing;

alter table pm.task_subteams enable row level security;
create policy "members read task_subteams" on pm.task_subteams for select
  using (pm.is_project_member(auth.uid(), (select project_id from pm.tasks where id = task_subteams.task_id)));
create policy "editors write task_subteams" on pm.task_subteams for all
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

grant select, insert, update, delete on pm.task_subteams to authenticated;

create or replace function pm.sync_task_primary_subteam() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
declare
  affected uuid := coalesce(new.task_id, old.task_id);
  prim uuid;
begin
  select subteam_id into prim from pm.task_subteams where task_id = affected and is_primary limit 1;
  if prim is not null then
    update pm.tasks set subteam_id = prim where id = affected and subteam_id is distinct from prim;
  end if;
  return null;
end; $$;
create trigger trg_task_subteams_sync_primary
  after insert or update or delete on pm.task_subteams
  for each row execute function pm.sync_task_primary_subteam();

create or replace function pm.seed_task_primary_subteam() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  insert into pm.task_subteams (task_id, subteam_id, is_primary)
    values (new.id, new.subteam_id, true)
    on conflict (task_id, subteam_id) do update set is_primary = true;
  return null;
end; $$;
create trigger trg_tasks_seed_primary_subteam
  after insert on pm.tasks
  for each row execute function pm.seed_task_primary_subteam();

create or replace function pm.set_task_primary_subteam(p_task_id uuid, p_subteam_id uuid) returns void
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  if not pm.can_edit_task(auth.uid(), p_task_id) then
    raise exception 'not authorized to edit task %', p_task_id;
  end if;
  insert into pm.task_subteams (task_id, subteam_id, is_primary)
    values (p_task_id, p_subteam_id, false)
    on conflict (task_id, subteam_id) do nothing;
  update pm.task_subteams set is_primary = false
    where task_id = p_task_id and is_primary and subteam_id <> p_subteam_id;
  update pm.task_subteams set is_primary = true
    where task_id = p_task_id and subteam_id = p_subteam_id;
end; $$;
grant execute on function pm.set_task_primary_subteam(uuid, uuid) to authenticated;
