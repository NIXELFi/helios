-- Phase 1L: give everyone PM access (owner: "make all viewers engineers so they
-- can use the PM"). The live PM RLS runs on pm.team_memberships +
-- pm.subteam_memberships (via pm.effective_role / is_project_member), which are
-- SEPARATE from the new Admin role system (pm.role_memberships). Rather than
-- rewire all of RLS at release time (risky), this MIRRORS the new roles into the
-- existing membership tables — purely additive (only grants, never revokes), so
-- there is no lockout risk and the current, working RLS does the enforcing.
--
-- (Follow-up: unify — make the RLS read the new model directly, or sync via a
--  trigger, so future Admin-UI changes flow through. Tracked in the RLS-flip plan.)

-- Project membership (required for ANY PM access): everyone becomes a member of
-- every active project. Org officers (Owner/Executive/President/COO/CFO/Chief
-- Engineer) are project 'admin'; everyone else is 'engineer'.
insert into pm.team_memberships (user_id, project_id, team_role)
select rm.user_id, p.id,
  case when exists (
    select 1 from pm.role_memberships m join pm.roles r on r.id = m.role_id
    where m.user_id = rm.user_id and r.scope = 'org'
  ) then 'admin'::pm.team_role else 'engineer'::pm.team_role end
from (select distinct user_id from pm.role_memberships) rm
cross join pm.projects p
where p.status = 'active'
on conflict (user_id, project_id) do nothing;

-- Subteam rank: mirror each subteam-scoped role (Lead/VP -> lead, else engineer).
insert into pm.subteam_memberships (user_id, subteam_id, role)
select m.user_id, m.subteam_id,
  case when r.key in ('lead', 'vp') then 'lead'::pm.team_role else 'engineer'::pm.team_role end
from pm.role_memberships m join pm.roles r on r.id = m.role_id
where m.subteam_id is not null
on conflict (user_id, subteam_id) do nothing;
