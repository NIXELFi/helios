-- Audit 2026-09-28 (v5.13.2 review), Priority 1 items 1-4.
--
-- 1. PM write policies for milestones, pages, blocks, vendors, calendar_events
--    and task_comments still gated on pm.user_role_in_project /
--    pm.is_project_member, which read ONLY the legacy pm.team_memberships table.
--    Members granted through Org & Access (most of the team since the 0617
--    mirror) have no row there, so their writes were RLS-denied. Tasks were
--    already bridged; repoint these at pm.effective_role (20260714030000),
--    which unions legacy rows with capability-derived roles. Same rank
--    thresholds as the originals.
-- 2. pm.list_directory() was granted to public + anon (20260831000000), so the
--    public anon key listed every user's name, email and subteams.
-- 3. marketplace.sign_message(bytea) never had its default PUBLIC execute
--    revoked, so authenticated inherited it: a signing oracle for the plugin key.
-- 4. pm.sync_gcal() is SECURITY DEFINER with no auth check and kept PUBLIC
--    execute; pg_cron runs it as postgres and is unaffected by the revoke.

-- 1. PM write policies -> effective_role ---------------------------------------

drop policy if exists "admins and leads write milestones" on pm.milestones;
create policy "admins and leads write milestones"
  on pm.milestones for all to authenticated
  using (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead'))
  with check (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead'));

drop policy if exists "engineers+ write pages" on pm.pages;
create policy "engineers+ write pages"
  on pm.pages for all to authenticated
  using (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'))
  with check (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'));

drop policy if exists "engineers+ write blocks" on pm.blocks;
create policy "engineers+ write blocks"
  on pm.blocks for all to authenticated
  using (pm.effective_role((select auth.uid()),
    (select project_id from pm.pages where id = page_id), null) in ('admin', 'lead', 'engineer'))
  with check (pm.effective_role((select auth.uid()),
    (select project_id from pm.pages where id = page_id), null) in ('admin', 'lead', 'engineer'));

drop policy if exists "engineers+ write vendors" on pm.vendors;
create policy "engineers+ write vendors"
  on pm.vendors for all to authenticated
  using (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'))
  with check (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'));

drop policy if exists "engineers+ write calendar_events" on pm.calendar_events;
create policy "engineers+ write calendar_events"
  on pm.calendar_events for all to authenticated
  using (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'))
  with check (pm.effective_role((select auth.uid()), project_id, null) in ('admin', 'lead', 'engineer'));

-- Any member who can read PM (viewer and up) may comment, as before.
drop policy if exists "members insert task_comments" on pm.task_comments;
create policy "members insert task_comments"
  on pm.task_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and pm.effective_role((select auth.uid()),
      (select project_id from pm.tasks where id = task_id), null) is not null
  );

-- 2. list_directory: signed-in only ---------------------------------------------
-- Helios Lite calls this after sign-in; verify before applying to prod.
revoke execute on function pm.list_directory() from public, anon;
grant execute on function pm.list_directory() to authenticated;

-- 3. sign_message: no client may call it --------------------------------------
revoke all on function marketplace.sign_message(bytea) from public, anon, authenticated;

-- 4. sync_gcal: cron only -------------------------------------------------------
revoke all on function pm.sync_gcal() from public, anon, authenticated;
