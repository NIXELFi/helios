-- v4.4.6 security: lock down internal pm backup/snapshot tables that were left
-- exposed in an API-visible schema without RLS.
--
-- Supabase Security Advisor reports two ERROR-level `rls_disabled_in_public`
-- findings:
--   - pm.tasks_project_move_backup
--   - pm.deleted_tasks_backup
-- Neither table is created by any migration -- they are ad-hoc safety snapshots
-- made directly on the hosted DB before risky operations, so they never had RLS
-- enabled. Because the `pm` schema is exposed through PostgREST, an authenticated
-- (or, depending on grants, anonymous) client could read these task snapshots.
--
-- Fix: enable RLS with NO policy (default-deny -- clients get zero rows) and
-- revoke direct table grants for defense in depth. SECURITY DEFINER maintenance
-- code (which runs as the table owner) is unaffected.
--
-- Each table is guarded by to_regclass(...) so this migration is a clean no-op on
-- a fresh rebuild where these ad-hoc tables don't exist (REVOKE has no IF EXISTS).
-- pm.tasks_status_backup already had RLS enabled (20260603050000); re-asserting it
-- here is harmless and keeps all three snapshot tables locked uniformly.

do $$
declare
  t text;
begin
  foreach t in array array[
    'pm.tasks_project_move_backup',
    'pm.deleted_tasks_backup',
    'pm.tasks_status_backup'
  ]
  loop
    if to_regclass(t) is not null then
      execute format('alter table %s enable row level security', t);
      execute format('revoke all on table %s from anon, authenticated', t);
    end if;
  end loop;
end $$;
