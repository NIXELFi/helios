-- Follow-up to 20260511000600 (RPC lockdown).
--
-- 20260511000600 used `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` for the
-- `public.pdm_*` proxy functions. That removes the PUBLIC pseudo-role's
-- implicit grant — but it does NOT remove any *explicit* grant on a
-- specific role like `anon`. The Supabase project's `public.pdm_*`
-- functions had `anon=X/postgres` baked into their ACL from project
-- bootstrap (Supabase auto-grants the standard roles on functions in
-- `public`), so anon retained EXECUTE access despite the FROM PUBLIC
-- revoke. The 0028 advisor lint confirmed this after the previous
-- migration ran.
--
-- This migration explicitly revokes EXECUTE from `anon` on every
-- `public.pdm_*` SECURITY DEFINER proxy, including the newly added
-- pdm_add_and_lock from 20260511000900.
--
-- The pdm-schema source functions (pdm.add_and_lock, pdm.check_in, etc.)
-- already had anon stripped by the previous migration (the schema is not
-- in Supabase's default-grant set), so we don't need to touch those.

revoke execute on function public.pdm_check_in(uuid, text, bigint, text) from anon;
revoke execute on function public.pdm_cancel_checkout(uuid) from anon;
revoke execute on function public.pdm_force_unlock(uuid, text) from anon;
revoke execute on function public.pdm_is_admin() from anon;
revoke execute on function public.pdm_add_and_lock(uuid, uuid, text, text, bigint, text) from anon;
