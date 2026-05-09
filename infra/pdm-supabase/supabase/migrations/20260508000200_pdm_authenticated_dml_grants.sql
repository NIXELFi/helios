-- The original schema migration (20260507000000_pdm_schema.sql) granted only
-- SELECT to authenticated. RLS policies can only RESTRICT what a role can do —
-- they cannot GRANT privileges. As a result, INSERT/UPDATE/DELETE fail with
-- 42501 "permission denied" before RLS even runs.
--
-- This migration grants the DML privileges that the existing RLS policies
-- already gate. Net effect: behavior matches what the RLS policies intend.

grant insert, update, delete on pdm.user_roles  to authenticated;
grant insert, update, delete on pdm.vaults       to authenticated;
grant insert, update, delete on pdm.folders      to authenticated;
grant insert, update, delete on pdm.files        to authenticated;
grant insert, update, delete on pdm.versions     to authenticated;
grant insert, update, delete on pdm.locks        to authenticated;

-- audit_log: only the security-definer trigger writes to it (running as
-- the function owner, not the caller). Authenticated needs SELECT only.
-- (Already granted by the original schema migration.)

-- refs: only the parse-refs edge function writes (service role).
-- Authenticated needs SELECT only.
