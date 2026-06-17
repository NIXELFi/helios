-- Admin triage note for support.reports (in-app bug/feature reports).
--
-- Lets an admin record HOW a report was resolved (or what they need from the
-- reporter) alongside the status. Shown read-only in the admin reports viewer.
-- The existing reports_select RLS already lets reporters read their own row, so
-- the note is visible to the reporter too — keep it factual.
--
-- APPLY via the Management API / MCP `apply_migration` (NOT `supabase db push`);
-- this committed file is the mirror. Additive + idempotent. No grant/policy
-- change: column privileges inherit the table grants, and reports_update already
-- gates writes to admins.

alter table support.reports
  add column if not exists admin_note text;
