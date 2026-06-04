-- PM role model integrated with PDM roles (the "PM-role → PM-capability mapping").
--
-- Applied to dlmyixonuyckxkknolku via the Management API; this file keeps the
-- repo / a from-scratch rebuild in sync. It does NOT change the live DB.
--
-- What it does: a user with ANY pdm.user_roles row can read PM (can_read_pm),
-- and their PDM role projects onto a PM team_role (pdm_team_role: owner/admin ->
-- admin, editor -> engineer, viewer -> viewer). The existing role resolvers
-- (user_role_in_project, effective_role, is_any_admin, my_team_roles) fall back
-- to that PDM-derived role, and every "members read <table>" SELECT policy now
-- also admits any PM reader. Replaces the pre-PDM-integration versions created in
-- 20260602000000_pm_schema.sql.

-- 1. Helpers (must precede the resolvers that call them) -----------------------
CREATE OR REPLACE FUNCTION pm.can_read_pm(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'pdm', 'public'
AS $function$
  select exists (select 1 from pdm.user_roles where user_id = uid);
$function$;

CREATE OR REPLACE FUNCTION pm.pdm_team_role(uid uuid)
 RETURNS pm.team_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'pdm', 'public'
AS $function$
  select case max(case ur.role
                    when 'owner'  then 4
                    when 'admin'  then 3
                    when 'editor' then 2
                    when 'viewer' then 1
                    else 0 end)
    when 4 then 'admin'::pm.team_role
    when 3 then 'admin'::pm.team_role
    when 2 then 'engineer'::pm.team_role
    when 1 then 'viewer'::pm.team_role
    else null
  end
  from pdm.user_roles ur
  where ur.user_id = uid;
$function$;

-- 2. Role resolvers (fall back to the PDM-derived role) -----------------------
CREATE OR REPLACE FUNCTION pm.user_role_in_project(uid uuid, pid uuid)
 RETURNS pm.team_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'pdm', 'public'
AS $function$
  select coalesce(
    (select team_role from pm.team_memberships where user_id = uid and project_id = pid limit 1),
    pm.pdm_team_role(uid)
  );
$function$;

CREATE OR REPLACE FUNCTION pm.effective_role(uid uuid, pid uuid, stid uuid)
 RETURNS pm.team_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'public'
AS $function$
  with r as (
    select pm.user_role_in_project(uid, pid)::text as pr,
           pm.user_role_in_subteam(uid, stid)::text as st
  )
  select case
    when not (pm.is_project_member(uid, pid) or pm.can_read_pm(uid)) then null
    when 'admin'    in (pr, st) then 'admin'::pm.team_role
    when 'lead'     in (pr, st) then 'lead'::pm.team_role
    when 'engineer' in (pr, st) then 'engineer'::pm.team_role
    when 'viewer'   in (pr, st) then 'viewer'::pm.team_role
    else null
  end
  from r;
$function$;

CREATE OR REPLACE FUNCTION pm.is_any_admin(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'pdm', 'public'
AS $function$
  select exists (
    select 1 from pm.team_memberships where user_id = uid and team_role = 'admin'
  ) or pm.pdm_team_role(uid) = 'admin';
$function$;

CREATE OR REPLACE FUNCTION pm.my_team_roles()
 RETURNS TABLE(project_id uuid, team_role pm.team_role)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pm', 'pdm', 'public'
AS $function$
  select p.id as project_id, pm.user_role_in_project(auth.uid(), p.id) as team_role
  from pm.projects p
  where pm.is_project_member(auth.uid(), p.id) or pm.can_read_pm(auth.uid());
$function$;

-- 3. "members read <table>" SELECT policies — also admit any PM reader --------
drop policy if exists "members read activity" on pm.activity;
create policy "members read activity" on pm.activity for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read blocks" on pm.blocks;
create policy "members read blocks" on pm.blocks for select to authenticated
  using (pm.is_project_member(auth.uid(), (select pages.project_id from pm.pages where pages.id = blocks.page_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read build_records" on pm.build_records;
create policy "members read build_records" on pm.build_records for select to authenticated
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = build_records.task_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read calendar_events" on pm.calendar_events;
create policy "members read calendar_events" on pm.calendar_events for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read views" on pm.database_views;
create policy "members read views" on pm.database_views for select to authenticated
  using ((pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid())) and ((owner_id = auth.uid()) or is_shared));

drop policy if exists "members read milestones" on pm.milestones;
create policy "members read milestones" on pm.milestones for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read pages" on pm.pages;
create policy "members read pages" on pm.pages for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read projects" on pm.projects;
create policy "members read projects" on pm.projects for select to authenticated
  using (pm.is_project_member(auth.uid(), id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read task_comments" on pm.task_comments;
create policy "members read task_comments" on pm.task_comments for select to authenticated
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = task_comments.task_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read task_dependencies" on pm.task_dependencies;
create policy "members read task_dependencies" on pm.task_dependencies for select to authenticated
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = task_dependencies.successor_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read task_milestones" on pm.task_milestones;
create policy "members read task_milestones" on pm.task_milestones for select to authenticated
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = task_milestones.task_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read task_part_link" on pm.task_part_link;
create policy "members read task_part_link" on pm.task_part_link for select to authenticated
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = task_part_link.task_id)) or pm.can_read_pm(auth.uid()));

-- NOTE: this policy is granted to PUBLIC (not authenticated) in prod — preserved.
drop policy if exists "members read task_subteams" on pm.task_subteams;
create policy "members read task_subteams" on pm.task_subteams for select to public
  using (pm.is_project_member(auth.uid(), (select tasks.project_id from pm.tasks where tasks.id = task_subteams.task_id)) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read tasks" on pm.tasks;
create policy "members read tasks" on pm.tasks for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read team_memberships" on pm.team_memberships;
create policy "members read team_memberships" on pm.team_memberships for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));

drop policy if exists "members read vendors" on pm.vendors;
create policy "members read vendors" on pm.vendors for select to authenticated
  using (pm.is_project_member(auth.uid(), project_id) or pm.can_read_pm(auth.uid()));
