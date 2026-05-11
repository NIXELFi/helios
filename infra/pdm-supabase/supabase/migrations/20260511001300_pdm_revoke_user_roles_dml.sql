-- M18 from ultrareview 2026-05-11 (defense in depth):
-- 20260508000200_pdm_authenticated_dml_grants granted INSERT/UPDATE/DELETE
-- on every pdm table including pdm.user_roles. Today RLS denies these for
-- non-admins (the *_admin_only* policies on user_roles), so it's not
-- exploitable, but the surface is wider than needed. A future policy
-- regression on user_roles would silently flip into a privilege-escalation
-- vector — non-admins could promote themselves once the deny stopped firing.
--
-- Revoke DML from authenticated. Admin role changes must go through SECURITY
-- DEFINER paths (service-role via bootstrap-admin.ts, or a future RPC).
-- SELECT remains in place so the editor/admin role checks in policies and
-- RPCs (and the bootstrap script's lookups) still work.

revoke insert, update, delete on pdm.user_roles from authenticated;
