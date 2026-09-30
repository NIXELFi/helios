-- pm.task_history, third cut: what the Productivity overhaul needs that the
-- activity log alone cannot say (docs/superpowers/specs/
-- 2026-09-14-productivity-view-overhaul-proposal.md, backlog items 5 and 8).
--
-- Four columns are ADDED to the returned row; nothing existing changes:
--
--   status_since     timestamptz  When the task entered its CURRENT status: the
--                                 latest `status_changed` activity row whose
--                                 payload->>'to' equals the live status, else
--                                 the task's updated_at. Measured against prod
--                                 (SDM27): 31 of 63 in-progress tasks have such
--                                 an event; the rest were imported in-status on
--                                 2026-06-02 and fall back to updated_at, which
--                                 is the honest answer for them too. This is
--                                 what "stuck for N days" and "untouched for N
--                                 days" are computed from — never created_at,
--                                 which is the import date for three quarters
--                                 of the corpus.
--   task_updated_at  timestamptz  The task row's updated_at, so the client can
--                                 take max(status_since, updated_at) as "last
--                                 touched".
--   owner_ids        uuid[]       Every owner from pm.task_owners, primary
--                                 first. UNGATED on purpose: owners are public
--                                 on the Board and in the Table already; this
--                                 only saves the client a join it cannot do
--                                 against history rows. NULL when unowned.
--   may_see_actors   boolean      The capability gate's verdict, stated once
--                                 per row instead of inferred from whether any
--                                 actor happened to be non-null. A lead looking
--                                 at a quiet week previously read as "gated
--                                 out". Actor columns are nulled exactly as
--                                 before; this is a label, not a loosening.
--
-- The return type changes, so the function is dropped and recreated (a plain
-- `create or replace` cannot change a function's result columns). The
-- ARGUMENT signature is identical, which is what lets a client built against
-- this migration fail soft on a server that has not applied it yet: the RPC
-- call still succeeds, the new columns simply come back undefined, and the
-- client treats them as unknown.
--
-- Everything else is unchanged from 20260914000100: `stable security definer`,
-- the membership check evaluated ONCE in a materialized CTE, the
-- (select auth.uid()) InitPlan pattern, the three union branches (logged
-- events / live open snapshot / synthetic completions), and actor columns
-- nulled unless the caller holds pm.manage_dashboard in the requested scope.
-- Every statement is idempotent.

drop function if exists pm.task_history(uuid, timestamptz, timestamptz, uuid);

create function pm.task_history(
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
  actual_days     numeric,
  status_since    timestamptz,
  task_updated_at timestamptz,
  owner_ids       uuid[],
  may_see_actors  boolean
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
  ),

  -- Per-task live state, computed once per task in the project (a few hundred
  -- rows) and joined by every branch below. status_since falls back to
  -- updated_at when no transition into the current status was ever logged.
  task_state as (
    select
      t.id,
      coalesce(
        (
          select max(a.created_at)
          from pm.activity a
          where a.target_type = 'task'
            and a.target_id = t.id
            and a.action = 'status_changed'
            and a.payload->>'to' = t.status::text
        ),
        t.updated_at
      ) as status_since,
      t.updated_at,
      (
        select array_agg(o.owner_id order by o.is_primary desc, o.created_at)
        from pm.task_owners o
        where o.task_id = t.id
      ) as owner_ids
    from pm.tasks t
    where t.project_id = p_project_id
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
    t.actual_days,
    ts.status_since,
    ts.updated_at,
    ts.owner_ids,
    g.may_see_actors
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
  left join task_state ts on ts.id = t.id
  left join pm.subteams s on s.id = coalesce(t.subteam_id, a.subteam_ids[1])
  left join auth.users u on u.id = a.actor_id and g.may_see_actors
  where p_subteam_id is null
     or t.subteam_id = p_subteam_id
     or a.subteam_ids @> array[p_subteam_id]
     or exists (
          select 1 from pm.task_subteams tsub
          where tsub.task_id = t.id and tsub.subteam_id = p_subteam_id
        )

  union all

  -- (B) LIVE SNAPSHOT of open work. One row per currently-not-done task in
  -- scope, NOT window-filtered on purpose (20260914000100 note 1). actor is
  -- always NULL here — nobody "did" this; it is a state, not an event.
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
    t.actual_days,
    ts.status_since,
    ts.updated_at,
    ts.owner_ids,
    g.may_see_actors
  from gate g
  join pm.tasks t
    on g.may_read
   and t.project_id = p_project_id
   and t.status <> 'done'
  left join task_state ts on ts.id = t.id
  left join pm.subteams s on s.id = t.subteam_id
  where p_subteam_id is null
     or t.subteam_id = p_subteam_id
     or exists (
          select 1 from pm.task_subteams tsub
          where tsub.task_id = t.id and tsub.subteam_id = p_subteam_id
        )

  union all

  -- (C) Done tasks the activity log never recorded a completion for
  -- (20260914000100 note 2). updated_at stands in for the completion time,
  -- updated_by for the actor — gated identically to a real actor.
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
    t.actual_days,
    ts.status_since,
    ts.updated_at,
    ts.owner_ids,
    g.may_see_actors
  from gate g
  join pm.tasks t
    on g.may_read
   and t.project_id = p_project_id
   and t.status = 'done'
   and t.updated_at >= p_from
   and t.updated_at <= p_to
  left join task_state ts on ts.id = t.id
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
           select 1 from pm.task_subteams tsub
           where tsub.task_id = t.id and tsub.subteam_id = p_subteam_id
         )
    )

  order by 2;
$$;

revoke all on function pm.task_history(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function pm.task_history(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- task_state adds two correlated subqueries per task in the project: the
-- status_since probe walks idx_activity_target, the owner aggregate the
-- task_owners primary key. At a few hundred tasks per project this is
-- single-digit milliseconds; no new index is added.
