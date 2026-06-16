-- Reporter identity for support.reports (in-app bug/feature reports).
--
-- The admin reports viewer runs as the `authenticated` role and cannot read
-- `auth.users` for OTHER users, so there is no server-side way to resolve a
-- reporter's name. We denormalize the submitter's display name / subteam /
-- email onto the row at insert time (set client-side in useSubmitReport from the
-- authenticated user's own metadata, which IS available to them).
--
-- APPLY via the Management API / MCP `apply_migration` (NOT `supabase db push`),
-- then this committed file is the mirror. Additive + idempotent; pre-existing
-- rows get NULLs (rendered as "Unknown" in the viewer). No grant/policy change
-- needed: column privileges inherit the table grants, and the insert RLS check
-- gates on reporter_id = auth.uid() only.

alter table support.reports
  add column if not exists reporter_name text,
  add column if not exists reporter_subteam text,
  add column if not exists reporter_email text;
