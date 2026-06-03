-- Expose the signed-in user's PM team role per project to the client (RLS-proof,
-- SECURITY DEFINER). Used to gate admin-only UI (milestone edit/delete, subteam
-- delete/reassign) and to mirror edit permissions in the UI.
create or replace function pm.my_team_roles()
  returns table (project_id uuid, team_role pm.team_role)
  language sql stable security definer set search_path to 'pm','public' as $$
  select project_id, team_role from pm.team_memberships where user_id = auth.uid();
$$;
grant execute on function pm.my_team_roles() to authenticated;
