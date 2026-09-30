-- Task history for the PM Productivity view.
--
-- One flattened row per task lifecycle event (created / status_changed /
-- completed / deleted) inside a time window, joined to the task's CURRENT row
-- so the client can compute cycle time, throughput, on-time rate and aging
-- without a second query path. Completion time is DERIVED from the latest
-- `completed` activity row for a task (see docs/superpowers/specs/
-- 2026-09-14-pm-productivity-history-design.md) — there is no completed_at
-- column and this migration adds none.
--
-- Security model:
--   * SECURITY DEFINER with an explicit membership check, following the 5.7.1
--     load-audit style (20260909100000_pdm_vault_cursor_rpc.sql): pm.activity's
--     RLS predicate would otherwise be evaluated per row over a whole season of
--     history. We check ONCE here, then read as the definer.
--   * `(select auth.uid())` so the planner folds it to an InitPlan instead of
--     re-evaluating the function per row (20260909100200).
--   * PERSON-LEVEL DATA IS GATED. actor_id / actor_name come back NULL unless
--     the caller holds pm.manage_dashboard in the requested scope — the same
--     gate as shared dashboard layouts (20260817000000). With p_subteam_id NULL
--     the request is project-wide, and has_capability(..., null) resolves to
--     org-scoped holders (Executive/Owner) only, which is the intent.
--   * A caller who is neither a project member nor a PM reader gets zero rows
--     (not an error) — the client renders its normal empty state.
--
-- Every statement is idempotent.

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
  with caller as (
    select (select auth.uid()) as uid
  ),
  gate as (
    select
      c.uid,
      -- Read gate: a member of this project, or anyone with PM read access
      -- (org default-deny posture, 20260714010000).
      (pm.is_project_member(c.uid, p_project_id) or pm.can_read_pm(c.uid)) as may_read,
      -- Actor gate: manage_dashboard in the requested scope.
      pm.has_capability(c.uid, 'pm.manage_dashboard', p_subteam_id) as may_see_actors
    from caller c
  )
  select
    a.id,
    a.created_at,
    a.action::text,
    a.target_id,
    -- The task's live title when it still exists; the name captured on the
    -- event otherwise (deleted tasks).
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
  order by a.created_at;
$$;

revoke all on function pm.task_history(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function pm.task_history(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- The window scan is (project_id, created_at) — already covered by
-- idx_activity_project. The action/target_type narrowing is a filter on top of
-- it; at the current history volume (one season) a partial index would not pay
-- for itself, so none is added.
