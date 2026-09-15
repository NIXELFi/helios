-- Subsystem writes follow the pm.manage_subsystems capability, not a legacy
-- project team-membership row.
--
-- Bug (support report 2026-09-12, High Voltage lead on 5.7.1): "I cannot add a
-- subsystem for my sub team - denied access." The INSERT policy on
-- pm.subsystems ("team members create subsystems") checked for ANY row in
-- pm.team_memberships for the caller. That table is only written by
-- create_project / create_first_project / clone_project_as_template, so every
-- account created after the initial projects were set up (77 of 123 users on
-- hosted, every EV-side lead included) has no row and is denied, even though
-- they hold pm.manage_subsystems for their subteam through their Lead role.
-- UPDATE/DELETE had no non-admin policy at all, so a lead could not rename or
-- remove a subsystem either.
--
-- Fix: gate all three writes on pm.has_capability(auth.uid(),
-- 'pm.manage_subsystems', subteam_id) - an org-scoped grant covers every
-- subteam, a subteam-scoped grant (Lead) covers that subteam only. The admin
-- policy ("admins write subsystems", FOR ALL via pm.is_any_admin) is untouched.
-- Idempotent.

drop policy if exists "team members create subsystems" on pm.subsystems;
drop policy if exists "subsystem managers create subsystems" on pm.subsystems;
drop policy if exists "subsystem managers update subsystems" on pm.subsystems;
drop policy if exists "subsystem managers delete subsystems" on pm.subsystems;

create policy "subsystem managers create subsystems" on pm.subsystems
  for insert to authenticated
  with check (pm.has_capability((select auth.uid()), 'pm.manage_subsystems', subteam_id));

create policy "subsystem managers update subsystems" on pm.subsystems
  for update to authenticated
  using (pm.has_capability((select auth.uid()), 'pm.manage_subsystems', subteam_id))
  with check (pm.has_capability((select auth.uid()), 'pm.manage_subsystems', subteam_id));

create policy "subsystem managers delete subsystems" on pm.subsystems
  for delete to authenticated
  using (pm.has_capability((select auth.uid()), 'pm.manage_subsystems', subteam_id));
