-- Fix H1 from ultrareview 2026-05-11:
-- 20260507000400_pdm_rls_versions.sql created a versions_insert_lockholder
-- policy that lets a lockholder insert a version with any version_num and any
-- parent_version_id. 20260508000200_pdm_authenticated_dml_grants.sql granted
-- INSERT/UPDATE/DELETE on pdm.* to authenticated, which together open a hole:
-- an authenticated editor holding a lock can bypass pdm.check_in and craft
-- arbitrary version rows (forking history, skipping numbers, lying about
-- parentage), still under RLS.
--
-- The safer fix is to force ALL writes to pdm.versions through pdm.check_in,
-- which is SECURITY DEFINER (verified in 20260508000300) and owns the
-- numbering, parentage, and audit-log logic.
--
-- Steps:
--   1. Drop the versions_insert_lockholder policy (insert path no longer used).
--   2. REVOKE INSERT/UPDATE/DELETE on pdm.versions from authenticated.
--   3. Keep versions_read intact (SELECT remains as before).
--
-- pdm.check_in is SECURITY DEFINER so it runs as the function owner (postgres)
-- and is unaffected by the revoke. Service role retains full access.

drop policy if exists versions_insert_lockholder on pdm.versions;

revoke insert, update, delete on pdm.versions from authenticated;
