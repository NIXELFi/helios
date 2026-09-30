-- pm.task_history, second cut: three blind spots measured against prod.
--
-- 20260914000000 built the history purely out of pm.activity rows inside the
-- window. Against real data that misses most of the picture:
--
--   1. OPEN WORK WITH NO RECENT EVENT. 107 of 240 currently-open tasks had no
--      activity row in the last 84 days, so the aging panel, the open totals
--      and the per-person open counts silently under-reported by ~45%. Aging is
--      a LIVE SNAPSHOT question ("how old is the work sitting on the board right
--      now"), not a windowed one, so a synthetic `open` row is emitted for every
--      open task in scope REGARDLESS of p_from/p_to.
--
--   2. DONE WORK WITH NO `completed` EVENT. 51 done tasks have no completed
--      activity row — 46 of them were seeded already-done on 2026-06-02 when the
--      PM was imported (the activity trigger only fires on insert and on status
--      CHANGE, so a task inserted at status 'done' never logged one), plus a
--      handful whose status was set before the trigger existed. Those are real
--      finished work and must count. A synthetic `completed` row is emitted for
--      each, timestamped t.updated_at — the best completion evidence the row
--      carries. Unlike the `open` rows these DO respect the window: they stand
--      in for an event that would have been windowed had it been logged.
--
--   3. SHARED SUBTEAMS. A task can belong to several subteams through
--      pm.task_subteams (480 rows in prod); the subteam filter only looked at
--      tasks.subteam_id and the event's captured subteam_ids, so a subteam's
--      Productivity view dropped every task it shares but does not own.
--
-- Everything else is unchanged: `stable security definer`, the membership check
-- evaluated ONCE in a materialized CTE, the (select auth.uid()) InitPlan
-- pattern, and actor columns nulled out unless the caller holds
-- pm.manage_dashboard in the requested scope — the synthetic completions are
-- gated exactly like real ones.
--
-- The signature and the 16 returned columns are identical to 20260914000000, so
-- this is a plain `create or replace` (no drop, no client contract change
-- beyond the new `open` action). Every statement is idempotent.

create or replace function pm.task_history(
  p_project_id uuid,
  p_from       timestamptz,
  p_to         timestamptz,
  p_subteam_id uuid default null
)
returns table (
  activity_id     uuid,
  event_time      timestamptz,
  action          text,
  task_id         uuid,
  task_title      text,
  subteam_id      uuid,
  subteam_name    text,
  status_from     text,
  status_to       text,
  actor_id        uuid,
  actor_name      text,
  task_created_at timestamptz,
  due_date        date,
  task_status_now text,
  estimate_days   numeric,
  actual_days     numeric
)
language sql
stable
security definer
set search_path = pm, public, auth
as $$
  -- MATERIALIZED so the two capability probes run once for the whole call
  -- rather than once per union branch (and never per row).
  with gate as materialized (
    select
      (select auth.uid()) as uid,
      (pm.is_project_member((select auth.uid()), p_project_id)
        or pm.can_read_pm((select auth.uid()))) as may_read,
      pm.has_capability((select auth.uid()), 'pm.manage_dashboard', p_subteam_id) as may_see_actors
  )

  -- (A) Real lifecycle events from the activity log, inside the window.
  select
    a.id,
    a.created_at,
    a.action::text,
    a.target_id,
    coalesce(t.title, a.target_name),
    coalesce(t.subteam_id, a.subteam_ids[1]),
    s.name,
    a.payload->>'from',
    a.payload->>'to',
    case when g.may_see_actors then a.actor_id end,
    case when g.may_see_actors then
      coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email::text)
    end,
    t.created_at,
    t.due_date,
    t.status::text,
    t.estimate_days,
    t.actual_days
  from gate g
  join pm.activity a
    on g.may_read
   and a.project_id = p_project_id
   and a.target_type = 'task'
   and a.action in ('created', 'status_changed', 'completed', 'deleted')
   and a.created_at >= p_from
   and a.created_at <= p_to
  -- LEFT: a `deleted` event outlives its task row, and must still be returned.
  left join pm.tasks t on t.id = a.target_id
  left join pm.subteams s on s.id = coalesce(t.subteam_id, a.subteam_ids[1])
  left join auth.users u on u.id = a.actor_id and g.may_see_actors
  where p_subteam_id is null
     or t.subteam_id = p_subteam_id
     or a.subteam_ids @> array[p_subteam_id]
     or exists (
          select 1 from pm.task_subteams ts
          where ts.task_id = t.id and ts.subteam_id = p_subteam_id
        )

  union all

  -- (B) LIVE SNAPSHOT of open work. One row per currently-not-done task in
  -- scope, stamped with its creation time so the client can age it. NOT
  -- window-filtered on purpose (see note 1 above): a task created two seasons
  -- ago and still open is exactly the row the aging panel exists to show.
  -- actor is always NULL here — nobody "did" this; it is a state, not an event.
  select
    null::uuid,
    t.created_at,
    'open'::text,
    t.id,
    t.title,
    t.subteam_id,
    s.name,
    null::text,
    null::text,
    null::uuid,
    null::text,
    t.created_at,
    t.due_date,
    t.status::text,
    t.estimate_days,
    t.actual_days
  from gate g
  join pm.tasks t
    on g.may_read
   and t.project_id = p_project_id
   and t.status <> 'done'
  left join pm.subteams s on s.id = t.subteam_id
  where p_subteam_id is null
     or t.subteam_id = p_subteam_id
     or exists (
          select 1 from pm.task_subteams ts
          where ts.task_id = t.id and ts.subteam_id = p_subteam_id
        )

  union all

  -- (C) Done tasks the activity log never recorded a completion for (see note 2
  -- above). `updated_at` stands in for the completion time, `updated_by` for the
  -- actor — gated identically to a real actor. status_from is NULL because no
  -- transition was ever captured; status_to is 'done' so the row reads like the
  -- completion it stands in for.
  select
    null::uuid,
    t.updated_at,
    'completed'::text,
    t.id,
    t.title,
    t.subteam_id,
    s.name,
    null::text,
    'done'::text,
    case when g.may_see_actors then t.updated_by end,
    case when g.may_see_actors then
      coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email::text)
    end,
    t.created_at,
    t.due_date,
    t.status::text,
    t.estimate_days,
    t.actual_days
  from gate g
  join pm.tasks t
    on g.may_read
   and t.project_id = p_project_id
   and t.status = 'done'
   and t.updated_at >= p_from
   and t.updated_at <= p_to
  left join pm.subteams s on s.id = t.subteam_id
  left join auth.users u on u.id = t.updated_by and g.may_see_actors
  where not exists (
          select 1 from pm.activity a2
          where a2.target_type = 'task'
            and a2.target_id = t.id
            and a2.action = 'completed'
        )
    and (
      p_subteam_id is null
      or t.subteam_id = p_subteam_id
      or exists (
           select 1 from pm.task_subteams ts
           where ts.task_id = t.id and ts.subteam_id = p_subteam_id
         )
    )

  order by 2;
$$;

revoke all on function pm.task_history(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function pm.task_history(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- Branch (B) scans pm.tasks by project and status; branch (C) adds an anti-join
-- on the activity log. idx_tasks_project + idx_activity_target already cover
-- both at the current volume (a few thousand tasks, one season of activity), so
-- no new index is added here.
