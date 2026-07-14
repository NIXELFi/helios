-- Bug-report triage for capability-only leadership (audit L2, approved for
-- v5.1.1).
--
-- support.reports (+ the report-attachments bucket) gated triage on the
-- legacy global pdm.is_admin() only. Capability-only leads/execs — who can
-- grant roles and administer vaults — could not read, re-status, or delete
-- reports, and could not open attached screenshots. Same one-surface-over
-- gap as the vault/PM bridges (20260714000000/030000).
--
-- "Triager" = anyone holding a role-granting capability via ANY membership:
-- org.grant_roles (execs, and leads per the current role editor config) or
-- pm.grant_subteam_roles (leads/VPs in the seed). This mirrors the client's
-- Org & Access rail gate, so whoever can manage people can triage reports.

-- Generic any-scope capability probe (pm.has_capability requires a subteam
-- match for subteam-scoped rows; triage is org-wide, scope doesn't matter).
create or replace function pm.has_any_capability(p_cap text)
returns boolean language sql stable security definer set search_path = pm, public as $$
  select exists (
    select 1
    from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = (select auth.uid())
      and rc.capability_key = p_cap
  );
$$;
revoke all on function pm.has_any_capability(text) from public, anon;
grant execute on function pm.has_any_capability(text) to authenticated;

create or replace function pm.can_triage_reports()
returns boolean language sql stable security definer set search_path = pm, public as $$
  select pm.has_any_capability('org.grant_roles')
      or pm.has_any_capability('pm.grant_subteam_roles');
$$;
revoke all on function pm.can_triage_reports() from public, anon;
grant execute on function pm.can_triage_reports() to authenticated;

-- support.reports: reads (own OR admin OR triager), status updates + deletes
-- (admin OR triager). INSERT (reporter self) is unchanged.
drop policy if exists reports_select on support.reports;
create policy reports_select on support.reports
  for select to authenticated
  using (pdm.is_admin() or reporter_id = (select auth.uid()) or pm.can_triage_reports());

drop policy if exists reports_update on support.reports;
create policy reports_update on support.reports
  for update to authenticated
  using (pdm.is_admin() or pm.can_triage_reports())
  with check (pdm.is_admin() or pm.can_triage_reports());

drop policy if exists reports_delete on support.reports;
create policy reports_delete on support.reports
  for delete to authenticated
  using (pdm.is_admin() or pm.can_triage_reports());

-- report-attachments bucket: same bridge for viewing/removing screenshots.
drop policy if exists report_attach_select on storage.objects;
create policy report_attach_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'report-attachments'
    and (pdm.is_admin() or owner = (select auth.uid()) or pm.can_triage_reports())
  );

drop policy if exists report_attach_delete on storage.objects;
create policy report_attach_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'report-attachments' and (pdm.is_admin() or pm.can_triage_reports()));
