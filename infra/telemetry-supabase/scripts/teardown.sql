-- Telemetry teardown — returns the database to its pre-telemetry baseline.
-- Run as service role / postgres. TEST ON THE LOCAL STACK FIRST.
--
--   psql "$DB_URL" -f scripts/teardown.sql
--
-- Storage objects must be emptied via the storage API first (SQL deletes the
-- catalog rows, but emptying through the API is the supported path):
--   supabase storage rm -r ss:///telemetry-sessions --experimental --linked
-- or loop storage.from('telemetry-sessions').remove(...) with service role.
--
-- Prints before/after database size proving return to baseline.

\echo '--- size before teardown ---'
select pg_size_pretty(pg_database_size(current_database())) as total_db_size;

-- 1. unschedule cron job (no-op when pg_cron absent or job missing)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'telemetry-prune-staging') then
      perform cron.unschedule('telemetry-prune-staging');
    end if;
  end if;
end;
$$;

-- 2. storage: policy, objects (belt-and-braces; API empty should precede), bucket
drop policy if exists "telemetry_sessions_authenticated_read" on storage.objects;
delete from storage.objects where bucket_id = 'telemetry-sessions';
delete from storage.buckets where id = 'telemetry-sessions';

-- 3. the schema itself — everything telemetry lives here, nothing else does
drop schema if exists telemetry cascade;

\echo '--- size after teardown ---'
select pg_size_pretty(pg_database_size(current_database())) as total_db_size;
\echo 'NOTE: run VACUUM separately if you need space returned to the OS;'
\echo 'pg_database_size shrinks fully only after autovacuum catches up.'
-- Edge function removal (optional, separate step):
--   supabase functions delete telemetry-ingest
