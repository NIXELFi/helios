-- Multiple owners per task with exactly one primary. pm.tasks.owner_id is KEPT
-- as the denormalized PRIMARY mirror (synced by trigger) so RLS (can_edit_task),
-- color-by-owner, the dashboard/report rollups, and every existing single-owner
-- read keep working unchanged. Mirrors the pm.task_subteams multi-membership
-- pattern, but owner_id is NULLABLE (a task may have no owner), and the sync is
-- BIDIRECTIONAL so the existing scalar owner_id write paths (detail Select, table
-- inline edit, bulk edit, task create) and the new co-owner writes both converge.
-- Applied to the hosted dev project (dlmyixonuyckxkknolku) via MCP apply_migration.

create table pm.task_owners (
  task_id    uuid not null references pm.tasks(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid(),
  primary key (task_id, owner_id)
);
create unique index task_owners_one_primary on pm.task_owners (task_id) where is_primary;
create index task_owners_owner_idx on pm.task_owners (owner_id);

-- Backfill: every task that already has an owner gets one primary membership.
insert into pm.task_owners (task_id, owner_id, is_primary)
  select id, owner_id, true from pm.tasks where owner_id is not null
  on conflict (task_id, owner_id) do nothing;

alter table pm.task_owners enable row level security;
create policy "members read task_owners" on pm.task_owners for select
  using (
    pm.is_project_member(auth.uid(), (select project_id from pm.tasks where id = task_owners.task_id))
    or pm.can_read_pm(auth.uid())
  );
create policy "editors write task_owners" on pm.task_owners for all
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

grant select, insert, update, delete on pm.task_owners to authenticated;

-- Trigger B: task_owners -> tasks.owner_id. Whenever the membership set changes,
-- re-home the denormalized primary mirror to the current primary owner (or NULL
-- when there is none). Guarded with pg_trigger_depth() = 0 so it never re-triggers
-- the tasks-side sync below (single-hop settle, no recursion).
create or replace function pm.sync_task_primary_owner() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
declare
  affected uuid := coalesce(new.task_id, old.task_id);
  prim uuid;
begin
  select owner_id into prim from pm.task_owners where task_id = affected and is_primary limit 1;
  update pm.tasks set owner_id = prim where id = affected and owner_id is distinct from prim;
  return null;
end; $$;
create trigger trg_task_owners_sync_primary
  after insert or update or delete on pm.task_owners
  for each row when (pg_trigger_depth() = 0)
  execute function pm.sync_task_primary_owner();

-- Trigger A: tasks.owner_id -> task_owners. A direct scalar write to owner_id
-- (the assign dropdown, inline table edit, bulk assign, or a task INSERT with an
-- owner) makes that user the PRIMARY membership. Reassigning or clearing the
-- owner DROPS the prior primary row (familiar "replace the owner" semantics);
-- co-owner rows (is_primary=false) are left untouched. Same depth guard so it
-- never re-triggers Trigger B.
create or replace function pm.sync_owner_to_task_owners() returns trigger
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  if tg_op = 'UPDATE' and old.owner_id is not null and old.owner_id is distinct from new.owner_id then
    delete from pm.task_owners where task_id = new.id and owner_id = old.owner_id and is_primary;
  end if;
  if new.owner_id is not null then
    insert into pm.task_owners (task_id, owner_id, is_primary)
      values (new.id, new.owner_id, true)
      on conflict (task_id, owner_id) do update set is_primary = true;
  end if;
  return null;
end; $$;
create trigger trg_tasks_sync_owner
  after insert or update of owner_id on pm.tasks
  for each row when (pg_trigger_depth() = 0)
  execute function pm.sync_owner_to_task_owners();

-- Promote an existing (or new) membership to primary, atomically. Auth-gated the
-- same way the RLS write policy is, so a non-editor can't flip ownership.
create or replace function pm.set_task_primary_owner(p_task_id uuid, p_owner_id uuid) returns void
  language plpgsql security definer set search_path to 'pm','public' as $$
begin
  if not pm.can_edit_task(auth.uid(), p_task_id) then
    raise exception 'not authorized to edit task %', p_task_id;
  end if;
  insert into pm.task_owners (task_id, owner_id, is_primary)
    values (p_task_id, p_owner_id, false)
    on conflict (task_id, owner_id) do nothing;
  update pm.task_owners set is_primary = false
    where task_id = p_task_id and is_primary and owner_id <> p_owner_id;
  update pm.task_owners set is_primary = true
    where task_id = p_task_id and owner_id = p_owner_id;
end; $$;
grant execute on function pm.set_task_primary_owner(uuid, uuid) to authenticated;

-- Extend the per-task edit check: a CO-OWNER (any task_owners row), not just the
-- primary owner_id or the creator, may edit the task. This is the whole point of
-- multi-owner — everyone working the task can change it. admins/leads unchanged.
create or replace function pm.can_edit_task(uid uuid, tid uuid)
  returns boolean
  language sql stable security definer set search_path to 'pm','public'
as $$
  select case pm.effective_role(uid, t.project_id, t.subteam_id)
    when 'admin' then true
    when 'lead' then true
    when 'engineer' then (
      t.owner_id = uid
      or t.created_by = uid
      or exists (select 1 from pm.task_owners o where o.task_id = t.id and o.owner_id = uid)
    )
    else false
  end
  from pm.tasks t where t.id = tid;
$$;
