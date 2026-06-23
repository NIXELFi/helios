-- Broaden pm.can_edit_task: a subteam EDITOR (engineer or above) may edit ANY
-- task in a project/subteam where they hold that role — not only tasks they
-- personally own or created. Admins/leads already had full edit; this lifts the
-- owner-only restriction on the 'engineer' tier.
--
-- "Subteam" means the task's primary subteam (pm.tasks.subteam_id) OR any subteam
-- the task is shared into via pm.task_subteams (the lateral union below), so a
-- task shared across subteams is editable by editors of any of them.
--
-- Role resolution reuses pm.effective_role for a single source of truth. NOTE on
-- who that admits: effective_role returns a role for a user who is a project
-- member OR who holds ANY global PDM role (pm.can_read_pm), because
-- pm.user_role_in_project falls back to pm.pdm_team_role. So a global PDM
-- editor/admin who is NOT an explicit project member already reads as engineer/
-- admin here — and after this change can edit all tasks in scope, the same way
-- they already appear as engineer in pm.my_team_roles (the UI's role source) and
-- can already create tasks via the "engineers+ insert tasks" policy. This keeps
-- can_edit_task consistent with the rest of the role model; scoping WHO is an
-- editor is governed by role assignment, not by this function. Only true viewers
-- / users with no PM role at all stay blocked.
--
-- This one function is the single edit gate: it backs the pm.tasks UPDATE policy,
-- the pm.task_owners ALL policy (so ownership reassignment is covered), the
-- pm.task_subteams and pm.task_links ALL policies, and the SECURITY DEFINER RPCs
-- pm.set_task_primary_owner / pm.set_task_primary_subteam. All widen by transitivity.
--
-- Source: in-app support report (Daniel Germaine, 2026-06-23, "edit permissions
-- for tasks for members"): "allow any editor of a subteam to be able to edit the
-- ownership of all tasks and all task properties in their subteam."
--
-- APPLY via the Management API / MCP apply_migration (NOT `supabase db push`);
-- this committed file is the mirror. Idempotent (create or replace).

create or replace function pm.can_edit_task(uid uuid, tid uuid)
  returns boolean
  language sql stable security definer set search_path to 'pm','public'
as $$
  select exists (
    select 1
    from pm.tasks t
    -- the task's primary subteam plus every subteam it is shared into; the row
    -- with a null subteam (a task with no subteam) still evaluates the
    -- project-level role via effective_role.
    cross join lateral (
      select t.subteam_id as st_id
      union
      select ts.subteam_id from pm.task_subteams ts where ts.task_id = t.id
    ) s
    where t.id = tid
      and pm.effective_role(uid, t.project_id, s.st_id) in (
        'admin'::pm.team_role, 'lead'::pm.team_role, 'engineer'::pm.team_role
      )
  );
$$;
