-- Bug/feature reports (in-app "Report a bug" button).
-- Spec: docs/superpowers/specs/2026-06-15-bug-feature-report-design.md
--
-- APPLY IN THE SUPABASE PASS (not via `supabase db push`): apply through the
-- Management API / MCP, commit this mirror, run the RLS suite. ALSO expose the
-- `support` schema in the project's API settings (PostgREST exposed schemas) so
-- the client's `.schema("support")` calls resolve. The desktop feature is inert
-- until both are done.

create schema if not exists support;
grant usage on schema support to authenticated;

create table if not exists support.reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reporter_id uuid not null references auth.users default auth.uid(),
  kind text not null check (kind in ('bug', 'feature')),
  -- No DB check on severity: allowed values differ by kind (bug:
  -- blocker/annoying/minor, feature: important/nice-to-have) and are enforced in
  -- the UI; keeping it free-text avoids a two-dimensional constraint.
  severity text not null,
  title text not null,
  what_doing text,
  details text,
  module text,
  app_version text,
  os text,
  breadcrumbs jsonb not null default '[]'::jsonb,
  last_error jsonb,
  screenshot_path text,
  status text not null default 'new' check (status in ('new', 'triaged', 'fixed'))
);

create index if not exists reports_created_at_idx on support.reports (created_at desc);
create index if not exists reports_reporter_idx on support.reports (reporter_id);

alter table support.reports enable row level security;

-- Insert: any authenticated user, only as themselves.
drop policy if exists reports_insert on support.reports;
create policy reports_insert on support.reports
  for insert to authenticated
  with check (reporter_id = auth.uid());

-- Select: admins/owners see everything; reporters see their own.
drop policy if exists reports_select on support.reports;
create policy reports_select on support.reports
  for select to authenticated
  using (pdm.is_admin() or reporter_id = auth.uid());

-- Update: admins/owners only (status triage). No delete policy (none allowed).
drop policy if exists reports_update on support.reports;
create policy reports_update on support.reports
  for update to authenticated
  using (pdm.is_admin())
  with check (pdm.is_admin());

-- Grant the privileges the policies gate; keep anon/public out.
grant select, insert, update on support.reports to authenticated;
revoke all on support.reports from anon, public;

-- Private bucket for optional screenshot attachments.
insert into storage.buckets (id, name, public)
values ('report-attachments', 'report-attachments', false)
on conflict (id) do nothing;

-- Storage policies (storage.objects) scoped to this bucket.
drop policy if exists report_attach_insert on storage.objects;
create policy report_attach_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'report-attachments');

-- Read: admins (the viewer) or the uploader of the object.
drop policy if exists report_attach_select on storage.objects;
create policy report_attach_select on storage.objects
  for select to authenticated
  using (bucket_id = 'report-attachments' and (pdm.is_admin() or owner = auth.uid()));
