-- pm.my_team_roles() — the PM UI's ONLY role source — still read raw
-- pm.team_memberships, the one surface left un-bridged by 20260714030000.
-- RLS accepts writes from capability-only members (an Org & Access grant of
-- Engineer/Lead/etc. with no team_memberships row — the standard onboarding
-- path; the 20260617011000 mirror was a one-time backfill, deliberately no
-- trigger), but the client read those users as "no role" and disabled every
-- edit control with "You don't have access to edit tasks in this project."
-- Same bug class as the vault-side fix in 20260714000000, one surface over.
--
-- Fix: report pm.effective_role per project — the SAME resolver the RLS edit
-- gates use (legacy project/subteam memberships + the pdm_team_role fallback
-- + the org capability bridge), evaluated at project scope (stid null). The
-- client model is one role per project with no subteam dimension (documented
-- at selectCanEditTask in pmStore.ts), so subteam-scoped nuance still
-- under-permits exactly as before — never over-permits: RLS stays the
-- enforcement either way.

create or replace function pm.my_team_roles()
  returns table (project_id uuid, team_role pm.team_role)
  language sql stable security definer set search_path to 'pm','public' as $$
  select p.id, r.role
  from pm.projects p
  cross join lateral (select pm.effective_role(auth.uid(), p.id, null::uuid) as role) r
  where r.role is not null;
$$;
grant execute on function pm.my_team_roles() to authenticated;
