-- Defense in depth: pdm.test_reset() must refuse to run unless an explicit
-- database-level setting marks the project as a test environment.
--
-- Why: during the ultrareview remediation pass, my local `pnpm -r test` runs
-- hit the live Supabase backend because infra/pdm-supabase/.env was pointing
-- at the production project's URL. test-or-skip.cjs honored the .env, the
-- integration suite ran, and its beforeEach hooks called pdm.test_reset() —
-- which wiped pdm.* + auth.users. The data was fake but the recovery still
-- took manual bootstrap. The function had no way to tell prod from test.
--
-- This migration adds a project-level safety check. To enable test_reset()
-- on a project, an admin runs once:
--
--   ALTER DATABASE postgres SET app.environment = 'test';
--
-- Production projects never set this, so test_reset() raises and aborts.
-- Test projects (the ones an integration suite is allowed to wipe) opt in
-- explicitly. The `current_setting(..., true)` form returns NULL when the
-- setting is unset (rather than erroring), so prod doesn't need any cleanup.

create or replace function pdm.test_reset()
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  if current_setting('app.environment', true) is distinct from 'test' then
    raise exception
      'pdm.test_reset() refused: app.environment is not "test". '
      'This safety check prevents wiping production data via a misconfigured '
      'integration test runner. Enable on a test-only project with: '
      'ALTER DATABASE postgres SET app.environment = ''test'';';
  end if;

  delete from pdm.audit_log where true;
  delete from pdm.refs where true;
  delete from pdm.versions where true;
  delete from pdm.locks where true;
  update pdm.files set latest_version_id = null where true;
  delete from pdm.files where true;
  delete from pdm.folders where true;
  delete from pdm.vaults where true;
  delete from pdm.user_roles where true;
end;
$$;
