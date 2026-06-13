-- Telemetry teardown — returns the database to its pre-telemetry baseline.
-- Run as service role / postgres. TEST ON THE LOCAL STACK FIRST.
--
--   psql "$DB_URL" -f scripts/teardown.sql
--
-- Storage MUST be removed via the Storage API — current Storage versions
-- install a storage.protect_delete() trigger that rejects direct SQL deletes
-- on storage.objects/storage.buckets (verified locally 2026-06-12). Run BEFORE
-- this script, with the service-role key:
--   curl -X POST   "$SUPABASE_URL/storage/v1/bucket/telemetry-sessions/empty" \
--        -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY"
--   curl -X DELETE "$SUPABASE_URL/storage/v1/bucket/telemetry-sessions" \
--        -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY"
-- (empty is queued async; retry the DELETE until it succeeds)
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

-- 2. storage policy (the bucket + objects themselves must already be gone via
--    the Storage API calls in the header — direct SQL deletes are rejected by
--    storage.protect_delete()). Abort if the bucket still exists.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'telemetry-sessions') then
    raise exception 'bucket telemetry-sessions still exists — empty + delete it via the Storage API first (see header)';
  end if;
end;
$$;
drop policy if exists "telemetry_sessions_authenticated_read" on storage.objects;

-- 3. the schema itself — everything telemetry lives here, nothing else does
drop schema if exists telemetry cascade;

\echo '--- size after teardown ---'
select pg_size_pretty(pg_database_size(current_database())) as total_db_size;
\echo 'NOTE: run VACUUM separately if you need space returned to the OS;'
\echo 'pg_database_size shrinks fully only after autovacuum catches up.'
-- Edge function removal (optional, separate step):
--   supabase functions delete telemetry-ingest
