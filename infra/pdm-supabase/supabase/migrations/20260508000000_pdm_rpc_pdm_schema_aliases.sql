-- Re-export the public.pdm_* RPCs in the pdm schema as well.
--
-- Background: the supabase-js client supports a single default schema via
-- `db.schema`. Our integration tests set `db.schema = 'pdm'` so `.from('locks')`
-- resolves to `pdm.locks` instead of `public.locks`. With that setting, RPC
-- calls also look in `pdm` first — so `client.rpc('pdm_check_in')` looks for
-- `pdm.pdm_check_in()`, not `public.pdm_check_in()`.
--
-- This migration adds aliases in the `pdm` schema that delegate to the existing
-- pdm.* implementation functions, keeping the original public proxies intact
-- (so any client that DOES use the public schema continues to work).

create or replace function pdm.pdm_is_admin()
returns boolean
language sql
security definer
stable
set search_path = pdm, public
as $$ select pdm.is_admin(); $$;

grant execute on function pdm.pdm_is_admin() to authenticated;

create or replace function pdm.pdm_check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
) returns pdm.versions
language sql
security definer
set search_path = pdm, public
as $$ select pdm.check_in(p_file_id, p_sha256, p_size, p_comment); $$;

grant execute on function pdm.pdm_check_in(uuid, text, bigint, text) to authenticated;

create or replace function pdm.pdm_force_unlock(p_lock_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = pdm, public
as $$ select pdm.force_unlock(p_lock_id, p_reason); $$;

grant execute on function pdm.pdm_force_unlock(uuid, text) to authenticated;

create or replace function pdm.pdm_cancel_checkout(p_file_id uuid)
returns void
language sql
security definer
set search_path = pdm, public
as $$ select pdm.cancel_checkout(p_file_id); $$;

grant execute on function pdm.pdm_cancel_checkout(uuid) to authenticated;
