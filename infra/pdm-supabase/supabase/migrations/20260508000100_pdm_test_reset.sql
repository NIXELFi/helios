-- Test-only RPC: wipes every pdm table in dependency order.
-- Used by integration tests' beforeEach hook. Service-role only.

create or replace function pdm.test_reset()
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  -- WHERE true clauses are required because Supabase enables pg_safeupdate,
  -- which blocks bare DELETE / UPDATE even inside SECURITY DEFINER functions.
  delete from pdm.audit_log where true;
  delete from pdm.refs where true;
  delete from pdm.versions where true;
  delete from pdm.locks where true;
  update pdm.files set latest_version_id = null where true;
  delete from pdm.files where true;
  delete from pdm.folders where true;
  delete from pdm.vaults where true;
  delete from pdm.user_roles where true;
  -- Storage objects are wiped via the Storage API on the JS test side
  -- (see resetPdmTables in tests/setup.ts). Supabase blocks direct DELETE
  -- on storage.objects with a trigger.
end;
$$;

-- Only the service role should ever call this — but PostgREST exposes any RPC
-- it has EXECUTE on. Restrict it to the postgres role (which Supabase service
-- role authenticates as for direct DB ops). The service-role JWT bypasses RLS
-- but DOES respect grants. Granting to service_role lets supabase-js with the
-- service key call it.
revoke all on function pdm.test_reset() from public;
grant execute on function pdm.test_reset() to service_role;
