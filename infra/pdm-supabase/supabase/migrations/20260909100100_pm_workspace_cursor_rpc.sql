-- PM change-signature in ONE request instead of five RLS'd probes.
--
-- Measured in prod (123 days to 2026-09-09): the five requests behind
-- fetchPmCursor were 13.3% of all database time — 1.07M calls at 72 ms for a
-- 797-row activity count, 80 ms for a 327-row task_owners count. As with the
-- vault cursor the cost is per-row RLS (pm.can_read_pm / pm.is_project_member
-- evaluated once per row); the same counts as the owner are sub-millisecond.
--
-- The newest-task probe also had no index to lean on: `order by updated_at
-- desc limit 1` over pm.tasks was a 29 ms sort of the whole table.
create index if not exists idx_tasks_updated_at on pm.tasks (updated_at desc);

-- Membership is checked ONCE in the WHERE clause; the counts then run as the
-- definer with no per-row policy calls. A caller who cannot read PM at all
-- gets ZERO ROWS (not a row of zeros) — the client reads that as "no access,
-- nothing changed" and holds its previous signature.
--
-- Like pdm.vault_cursor these are a change signal, not a row count the caller
-- is entitled to see: pm.can_read_pm is the whole-org read gate, so anyone who
-- passes it can read every one of these tables anyway.
create or replace function pm.workspace_cursor()
returns table (tasks bigint, tasks_updated_at timestamptz, activity bigint, task_owners bigint, task_links bigint)
language sql stable security definer set search_path = pm, public as $$
  select
    (select count(*) from pm.tasks),
    (select max(updated_at) from pm.tasks),
    (select count(*) from pm.activity),
    (select count(*) from pm.task_owners),
    (select count(*) from pm.task_links)
  where pm.can_read_pm((select auth.uid()));
$$;
revoke all on function pm.workspace_cursor() from public, anon;
grant execute on function pm.workspace_cursor() to authenticated;
