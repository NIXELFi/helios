-- PM quick-create subsystems (2026-06-09): subsystem creation was effectively
-- admin-only ("admins write subsystems" FOR ALL), which made the org structure
-- feel hardcoded — engineers assigning tasks couldn't add the subsystem they
-- needed. Team members (any pm.team_memberships row) may now INSERT
-- subsystems; UPDATE/DELETE stay admin-only via the existing policy.
-- APPLIED TO HOSTED 2026-06-09 via MCP apply_migration.
create policy "team members create subsystems" on pm.subsystems
  for insert to authenticated
  with check (
    exists (select 1 from pm.team_memberships tm where tm.user_id = auth.uid())
  );
