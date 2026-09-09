-- PM read policies: evaluate the org-wide read gate ONCE per statement.
--
-- Every "members read <table>" SELECT policy was written as
--   pm.is_project_member(auth.uid(), <project expr>) or pm.can_read_pm(auth.uid())
-- Both calls reference no row column in their arguments except the project
-- expression, but because they are plain function calls in the USING clause,
-- Postgres re-evaluates BOTH for every candidate row. Measured in prod
-- (2026-09-09): pm.team_memberships had 3.64 BILLION index scans from
-- is_project_member, and a 797-row count of pm.activity took 72 ms.
--
-- Two changes, no semantic change at all:
--   1. Order the OR so the CHEAP whole-org test comes first. Every current
--      team member passes can_read_pm, so is_project_member is only reached
--      for users who fail it (OR short-circuits left to right).
--   2. Wrap the row-independent parts in scalar subqueries —
--      `(select pm.can_read_pm((select auth.uid())))`. Postgres hoists a
--      row-independent subquery into an InitPlan and runs it ONCE per
--      statement instead of once per row. This is the same rewrite Supabase's
--      own RLS performance guide recommends for `auth.uid()`.
-- The truth table is identical: same two predicates, same OR.
--
-- ROLES ARE PRESERVED EXACTLY. Three of these policies are granted to PUBLIC
-- in prod rather than to authenticated (they were created without a `to`
-- clause in 20260603110000 / 20260617012000 / 20260617013000):
-- members read task_subteams, members read task_owners, members read
-- task_links. They stay `to public` here — anon still cannot read the rows
-- (auth.uid() is null, so both predicates are false), but changing the role
-- would be an undeclared behaviour change.

-- ── project_id on the row ───────────────────────────────────────────────────
drop policy if exists "members read activity" on pm.activity;
create policy "members read activity" on pm.activity for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read calendar_events" on pm.calendar_events;
create policy "members read calendar_events" on pm.calendar_events for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read milestones" on pm.milestones;
create policy "members read milestones" on pm.milestones for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read pages" on pm.pages;
create policy "members read pages" on pm.pages for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read tasks" on pm.tasks;
create policy "members read tasks" on pm.tasks for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read team_memberships" on pm.team_memberships;
create policy "members read team_memberships" on pm.team_memberships for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

drop policy if exists "members read vendors" on pm.vendors;
create policy "members read vendors" on pm.vendors for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), project_id)
  );

-- ── the project IS the row ──────────────────────────────────────────────────
drop policy if exists "members read projects" on pm.projects;
create policy "members read projects" on pm.projects for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), id)
  );

-- ── project resolved through the parent page ────────────────────────────────
drop policy if exists "members read blocks" on pm.blocks;
create policy "members read blocks" on pm.blocks for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select pages.project_id from pm.pages where pages.id = blocks.page_id))
  );

-- ── project resolved through the parent task ───────────────────────────────
drop policy if exists "members read build_records" on pm.build_records;
create policy "members read build_records" on pm.build_records for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = build_records.task_id))
  );

drop policy if exists "members read task_comments" on pm.task_comments;
create policy "members read task_comments" on pm.task_comments for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_comments.task_id))
  );

drop policy if exists "members read task_milestones" on pm.task_milestones;
create policy "members read task_milestones" on pm.task_milestones for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_milestones.task_id))
  );

drop policy if exists "members read task_part_link" on pm.task_part_link;
create policy "members read task_part_link" on pm.task_part_link for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_part_link.task_id))
  );

drop policy if exists "members read task_dependencies" on pm.task_dependencies;
create policy "members read task_dependencies" on pm.task_dependencies for select to authenticated
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_dependencies.successor_id))
  );

-- ── the three PUBLIC-role policies (role preserved, see the header) ─────────
drop policy if exists "members read task_links" on pm.task_links;
create policy "members read task_links" on pm.task_links for select to public
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_links.task_id))
  );

drop policy if exists "members read task_owners" on pm.task_owners;
create policy "members read task_owners" on pm.task_owners for select to public
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_owners.task_id))
  );

drop policy if exists "members read task_subteams" on pm.task_subteams;
create policy "members read task_subteams" on pm.task_subteams for select to public
  using (
    (select pm.can_read_pm((select auth.uid())))
    or pm.is_project_member((select auth.uid()), (select tasks.project_id from pm.tasks where tasks.id = task_subteams.task_id))
  );

-- ── saved database views: same gate, plus the per-owner/shared filter ───────
drop policy if exists "members read views" on pm.database_views;
create policy "members read views" on pm.database_views for select to authenticated
  using (
    (
      (select pm.can_read_pm((select auth.uid())))
      or pm.is_project_member((select auth.uid()), project_id)
    )
    and (owner_id = (select auth.uid()) or is_shared)
  );

-- ── self-rows only; auth.uid() hoisted the same way ────────────────────────
drop policy if exists role_memberships_select_self on pm.role_memberships;
create policy role_memberships_select_self on pm.role_memberships for select to authenticated
  using (user_id = (select auth.uid()));
