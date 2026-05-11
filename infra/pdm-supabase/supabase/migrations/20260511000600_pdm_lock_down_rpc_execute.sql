-- Fix new HIGH finding from Supabase advisors (2026-05-11):
-- Every SECURITY DEFINER function in `pdm` and `public.pdm_*` is currently
-- executable by the `anon` role (i.e. callable without signing in). For
-- write RPCs like pdm.check_in / pdm.force_unlock that is a security hole:
-- an unauthenticated request can still trigger the function body (which
-- runs as `postgres` thanks to DEFINER), and the function's internal
-- `auth.uid()` call will return null but the side effects still execute.
--
-- Postgres' default for new functions is EXECUTE to PUBLIC. Supabase's
-- exposure pattern is to layer GRANTs over this rather than starting from
-- "no one can execute" — which leaves anon with execute access on every
-- SECURITY DEFINER unless explicitly revoked.
--
-- This migration:
--   1. Revokes EXECUTE from PUBLIC on every SECURITY DEFINER function in
--      pdm and the public.pdm_* proxies (closes anon access).
--   2. Re-grants EXECUTE to the appropriate role:
--      * Trigger functions: nobody (triggers fire as table owner).
--      * User-facing RPCs (check_in, cancel_checkout, force_unlock,
--        is_admin and their schema-aliased proxies): `authenticated`.
--      * `pdm.test_reset`: `service_role` only.

-- Trigger functions — revoke from everyone except service_role (which
-- inherits via security definer ownership).
revoke execute on function pdm.trg_files_check_vault_consistency() from public;
revoke execute on function pdm.trg_locks_audit() from public;
revoke execute on function pdm.trg_locks_audit_update() from public;

-- User-facing RPCs — revoke from PUBLIC, grant to authenticated.
revoke execute on function pdm.check_in(uuid, text, bigint, text) from public;
grant   execute on function pdm.check_in(uuid, text, bigint, text) to authenticated;

revoke execute on function pdm.cancel_checkout(uuid) from public;
grant   execute on function pdm.cancel_checkout(uuid) to authenticated;

revoke execute on function pdm.force_unlock(uuid, text) from public;
grant   execute on function pdm.force_unlock(uuid, text) to authenticated;

revoke execute on function pdm.is_admin() from public;
grant   execute on function pdm.is_admin() to authenticated;

-- Schema-aliased proxies in pdm.
revoke execute on function pdm.pdm_check_in(uuid, text, bigint, text) from public;
grant   execute on function pdm.pdm_check_in(uuid, text, bigint, text) to authenticated;

revoke execute on function pdm.pdm_cancel_checkout(uuid) from public;
grant   execute on function pdm.pdm_cancel_checkout(uuid) to authenticated;

revoke execute on function pdm.pdm_force_unlock(uuid, text) from public;
grant   execute on function pdm.pdm_force_unlock(uuid, text) to authenticated;

revoke execute on function pdm.pdm_is_admin() from public;
grant   execute on function pdm.pdm_is_admin() to authenticated;

-- Public-schema proxies (these are the actual /rest/v1/rpc/<name> endpoints
-- the PostgREST client hits).
revoke execute on function public.pdm_check_in(uuid, text, bigint, text) from public;
grant   execute on function public.pdm_check_in(uuid, text, bigint, text) to authenticated;

revoke execute on function public.pdm_cancel_checkout(uuid) from public;
grant   execute on function public.pdm_cancel_checkout(uuid) to authenticated;

revoke execute on function public.pdm_force_unlock(uuid, text) from public;
grant   execute on function public.pdm_force_unlock(uuid, text) to authenticated;

revoke execute on function public.pdm_is_admin() from public;
grant   execute on function public.pdm_is_admin() to authenticated;

-- Dangerous: test-reset wipes the vault. Service role only — revoke from
-- everything else to be explicit. (Already not granted to anon/authenticated
-- but make it impossible to grant by accident in a later migration.)
revoke execute on function pdm.test_reset() from public;
revoke execute on function pdm.test_reset() from authenticated;
revoke execute on function pdm.test_reset() from anon;
