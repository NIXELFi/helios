-- Staging retention (pg_cron when available) + telemetry storage bucket.
-- Both halves are guarded and Vault-safe: no existing bucket, policy, or
-- cron job is touched.

-- ── staging retention ───────────────────────────────────────────────────────
-- Deletes staging rows already compacted longer ago than the retention
-- interval, keeping the ring buffer bounded. Retention is configurable via
-- telemetry.config; default 1 hour.
create table telemetry.config (
  key   text primary key,
  value jsonb not null
);
alter table telemetry.config enable row level security;
create policy authenticated_read on telemetry.config for select to authenticated using (true);
grant select on telemetry.config to authenticated;

insert into telemetry.config (key, value) values
  ('staging_retention', '"1 hour"'::jsonb)
on conflict (key) do nothing;

create or replace function telemetry.prune_staging()
returns bigint
language plpgsql
security definer
set search_path = telemetry, pg_temp
as $$
declare
  retention interval;
  deleted   bigint;
begin
  select (value #>> '{}')::interval into retention
    from telemetry.config where key = 'staging_retention';
  retention := coalesce(retention, interval '1 hour');
  delete from telemetry.staging_chunks
    where compacted_at is not null
      and compacted_at < now() - retention;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
-- Lock down: only service paths may execute (pg_cron runs as the job owner).
revoke execute on function telemetry.prune_staging() from public, anon, authenticated;

-- Schedule via pg_cron ONLY if the extension is installed. On hosted Supabase
-- enable it first (Dashboard → Database → Extensions → pg_cron); if it is
-- unavailable the compactor performs its own pruning by calling
-- telemetry.prune_staging() at the end of each compaction pass.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'telemetry-prune-staging',
      '*/5 * * * *',
      $job$ select telemetry.prune_staging(); $job$
    );
  else
    raise notice 'pg_cron not installed; compactor fallback pruning will apply';
  end if;
end;
$$;

-- ── storage bucket: telemetry-sessions (private) ────────────────────────────
-- Parquet objects keyed sessions/{session_id}/{group_key}/{seq_range}.parquet
insert into storage.buckets (id, name, public)
values ('telemetry-sessions', 'telemetry-sessions', false)
on conflict (id) do nothing;

-- Reads for authenticated users, scoped strictly to this bucket. Writes are
-- service-role only (no insert/update/delete policies ⇒ only service role,
-- which bypasses RLS, can write). Policy names are namespaced to avoid any
-- collision with Vault storage policies.
create policy "telemetry_sessions_authenticated_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'telemetry-sessions');

-- ── reversibility ───────────────────────────────────────────────────────────
-- Down:
--   select cron.unschedule('telemetry-prune-staging');         -- if scheduled
--   drop policy "telemetry_sessions_authenticated_read" on storage.objects;
--   delete from storage.objects where bucket_id = 'telemetry-sessions';
--   delete from storage.buckets where id = 'telemetry-sessions';
--   drop schema telemetry cascade;   -- (covers config + prune_staging too)
