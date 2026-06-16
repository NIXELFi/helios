-- Admin delete for support.reports + their screenshot attachments.
--
-- The original 20260615000000_support_reports migration intentionally shipped
-- with NO delete policy. This adds admin-only HARD delete to back the in-app
-- reports viewer's Delete action. Only admins/owners ever see that viewer, and
-- RLS double-gates the delete here regardless of the UI.
--
-- APPLY via the Management API / MCP `apply_migration` (NOT `supabase db push`);
-- this committed file is the mirror. Idempotent (drop policy if exists).

-- Row delete: admins/owners only.
drop policy if exists reports_delete on support.reports;
create policy reports_delete on support.reports
  for delete to authenticated
  using (pdm.is_admin());

grant delete on support.reports to authenticated;

-- Storage object delete: admins only, scoped to the report-attachments bucket.
-- (The object's owner is the reporter — a non-admin — so admins need an explicit
-- delete policy to remove someone else's uploaded screenshot.)
drop policy if exists report_attach_delete on storage.objects;
create policy report_attach_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'report-attachments' and pdm.is_admin());
