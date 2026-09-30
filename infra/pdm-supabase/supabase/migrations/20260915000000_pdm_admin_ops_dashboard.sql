-- Admin > Pulse: org-wide health + growth dashboard.
--
-- Two halves:
--   1. pdm.ops_daily - one row per UTC day of growth/activity metrics. Filled by
--      pdm.ops_snapshot(day) (nightly pg_cron, plus a one-time backfill from
--      the first sign-up) so the charts keep history even after Supabase prunes
--      old auth sessions / refresh tokens.
--   2. Read RPCs, all gated on pdm.is_global_admin() and exposed through the
--      house pdm_* / public.pdm_* proxies:
--        admin_ops_overview()      live headline numbers + infra health (jsonb)
--        admin_ops_series(p_days)  the daily rows for the charts
--        admin_ops_people()        per-person presence / last seen / 30d activity
--        admin_ops_hourly()        7x24 activity heatmap over the last 30 days
--
-- "Daily active" = distinct users whose session refreshed that day (a refresh
-- token was minted). That is "had Helios open", not "clicked sign in"; the auth
-- audit table is empty on hosted so there is no cleaner login signal.
-- Idempotent: create if not exists / create or replace / cron.schedule upserts.

-- ---------------------------------------------------------------------------
-- 1. Snapshot table
-- ---------------------------------------------------------------------------
create table if not exists pdm.ops_daily (
  day               date primary key,
  users_total       integer not null default 0,
  users_new         integer not null default 0,
  active_users      integer not null default 0,
  vault_actions     integer not null default 0,
  pm_actions        integer not null default 0,
  games_plays       integer not null default 0,
  notify_sent       integer not null default 0,
  notify_failed     integer not null default 0,
  files_total       integer not null default 0,
  versions_total    integer not null default 0,
  content_bytes     bigint  not null default 0,
  storage_bytes     bigint,            -- live only (null for backfilled days)
  db_bytes          bigint,            -- live only
  vault_files       jsonb   not null default '{}'::jsonb,  -- {vault name: files}
  computed_at       timestamptz not null default now()
);
alter table pdm.ops_daily enable row level security;
-- No policies on purpose: reads go through the SECURITY DEFINER RPCs below.
revoke all on pdm.ops_daily from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Compute one day's metrics (pure read; used by snapshot + backfill)
-- ---------------------------------------------------------------------------
create or replace function pdm.ops_compute_day(p_day date)
returns pdm.ops_daily
language plpgsql stable security definer
set search_path = pdm, public, auth, pm, games, notify
as $$
declare
  d0 timestamptz := (p_day::timestamp) at time zone 'utc';        -- UTC midnight, regardless of session TimeZone
  d1 timestamptz := ((p_day + 1)::timestamp) at time zone 'utc';
  r  pdm.ops_daily;
begin
  r.day := p_day;
  r.computed_at := now();

  select count(*) into r.users_total from auth.users where created_at < d1;
  select count(*) into r.users_new   from auth.users where created_at >= d0 and created_at < d1;

  select count(distinct user_id) into r.active_users from (
    select user_id::text as user_id from auth.refresh_tokens where created_at >= d0 and created_at < d1
    union
    select user_id::text from auth.sessions
      where refreshed_at >= (d0 at time zone 'utc') and refreshed_at < (d1 at time zone 'utc')
    union
    select id::text from auth.users where last_sign_in_at >= d0 and last_sign_in_at < d1
  ) a;

  select count(*) into r.vault_actions from pdm.audit_log where ts >= d0 and ts < d1;
  select count(*) into r.pm_actions    from pm.activity   where created_at >= d0 and created_at < d1;
  select (select count(*) from games.bets   where created_at >= d0 and created_at < d1)
       + (select count(*) from games.scores where created_at >= d0 and created_at < d1)
    into r.games_plays;
  select count(*) into r.notify_sent   from notify.outbox where sent_at >= d0 and sent_at < d1 and status = 'sent';
  select count(*) into r.notify_failed from notify.outbox where created_at >= d0 and created_at < d1 and status = 'dead';

  select count(*) into r.files_total    from pdm.files    where created_at < d1 and (deleted_at is null or deleted_at >= d1);
  select count(*) into r.versions_total from pdm.versions where created_at < d1;
  select coalesce(sum(size_bytes), 0) into r.content_bytes from pdm.versions where created_at < d1;

  select coalesce(jsonb_object_agg(v.name, c.n), '{}'::jsonb) into r.vault_files
  from pdm.vaults v
  join lateral (
    select count(*) as n from pdm.files f
    where f.vault_id = v.id and f.created_at < d1 and (f.deleted_at is null or f.deleted_at >= d1)
  ) c on true;

  -- Live-only gauges: meaningful for "today", unknowable for the past.
  if p_day >= (now() at time zone 'utc')::date then
    select pg_database_size(current_database()) into r.db_bytes;
    select coalesce(sum((metadata->>'size')::bigint), 0) into r.storage_bytes from storage.objects;
  end if;
  return r;
end; $$;
revoke all on function pdm.ops_compute_day(date) from public, anon, authenticated;

create or replace function pdm.ops_snapshot(p_day date default (current_date - 1))
returns void
language plpgsql security definer
set search_path = pdm, public
as $$
declare r pdm.ops_daily;
begin
  r := pdm.ops_compute_day(p_day);
  insert into pdm.ops_daily as t values (r.*)
  on conflict (day) do update set
    users_total = excluded.users_total, users_new = excluded.users_new,
    active_users = excluded.active_users, vault_actions = excluded.vault_actions,
    pm_actions = excluded.pm_actions, games_plays = excluded.games_plays,
    notify_sent = excluded.notify_sent, notify_failed = excluded.notify_failed,
    files_total = excluded.files_total, versions_total = excluded.versions_total,
    content_bytes = excluded.content_bytes,
    storage_bytes = coalesce(excluded.storage_bytes, t.storage_bytes),
    db_bytes = coalesce(excluded.db_bytes, t.db_bytes),
    vault_files = excluded.vault_files, computed_at = excluded.computed_at;
end; $$;
revoke all on function pdm.ops_snapshot(date) from public, anon, authenticated;

-- Nightly at 00:10 UTC: finalize yesterday. cron.schedule upserts by name.
select cron.schedule('helios-ops-daily', '10 0 * * *', $$select pdm.ops_snapshot(current_date - 1);$$);

-- One-time backfill from the first sign-up (2026-05-29 on hosted) through
-- yesterday. Cheap (a few hundred days x small tables); only fills gaps.
do $$
declare d date;
begin
  for d in
    select gs::date from generate_series(
      (select least(min(created_at)::date, current_date) from auth.users),
      current_date - 1, interval '1 day') gs
  loop
    if not exists (select 1 from pdm.ops_daily where day = d) then
      perform pdm.ops_snapshot(d);
    end if;
  end loop;
end $$;

-- The 7-day and per-day scans above and below filter audit_log on ts; the
-- table only had a (target_type, target_id) index.
create index if not exists audit_log_ts_idx on pdm.audit_log (ts);

-- ---------------------------------------------------------------------------
-- 3. Read RPCs (global-admin gated)
-- ---------------------------------------------------------------------------
create or replace function pdm.admin_ops_overview()
returns jsonb
language plpgsql stable security definer
set search_path = pdm, public, auth, pm, games, notify, cron
as $$
declare
  today pdm.ops_daily;
  out   jsonb;
begin
  if not pdm.is_global_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  today := pdm.ops_compute_day((now() at time zone 'utc')::date);

  select jsonb_build_object(
    'as_of', now(),
    'today', to_jsonb(today),
    'online_now', (
      -- refreshed_at stays NULL until the first access-token refresh, so a
      -- session created minutes ago counts via created_at.
      select count(distinct user_id) from auth.sessions
      where greatest(coalesce(refreshed_at, '-infinity'::timestamp), created_at at time zone 'utc')
            >= (now() at time zone 'utc') - interval '10 minutes'),
    'active_7d', (
      select count(distinct user_id) from auth.refresh_tokens where created_at >= now() - interval '7 days'),
    'active_30d', (
      select count(distinct user_id) from auth.refresh_tokens where created_at >= now() - interval '30 days'),
    'users_new_7d',  (select count(*) from auth.users where created_at >= now() - interval '7 days'),
    'users_new_30d', (select count(*) from auth.users where created_at >= now() - interval '30 days'),
    'sessions_live', (select count(*) from auth.sessions where not_after is null or not_after > now()),
    'locks_active', (select count(*) from pdm.locks where released_at is null),
    'drafts_unpublished', (select count(*) from pdm.files where published_at is null and deleted_at is null),
    'recycle_bin', (select count(*) from pdm.files where deleted_at is not null),
    'notify', jsonb_build_object(
      'queued',   (select count(*) from notify.outbox where status = 'pending'),
      'failed_24h', (select count(*) from notify.outbox where status = 'dead' and created_at >= now() - interval '24 hours'),
      'sent_24h', (select count(*) from notify.outbox where status = 'sent' and sent_at >= now() - interval '24 hours'),
      'last_sent', (select max(sent_at) from notify.outbox)),
    'games', jsonb_build_object(
      'bets_24h',   (select count(*) from games.bets where created_at >= now() - interval '24 hours'),
      'scores_24h', (select count(*) from games.scores where created_at >= now() - interval '24 hours'),
      'players_7d', (select count(distinct user_id) from games.bets where created_at >= now() - interval '7 days'),
      'banned', (select count(*) from games.banned_players)),
    'db', jsonb_build_object(
      'bytes', pg_database_size(current_database()),
      'connections', (select count(*) from pg_stat_activity where datname = current_database()),
      'connections_active', (select count(*) from pg_stat_activity where datname = current_database() and state = 'active'),
      'max_connections', current_setting('max_connections')::int,
      'cache_hit_pct', (select round(100.0 * sum(blks_hit) / greatest(sum(blks_hit) + sum(blks_read), 1), 1)
                         from pg_stat_database where datname = current_database()),
      'tables', (
        select jsonb_agg(jsonb_build_object('name', n.nspname || '.' || c.relname,
                                            'bytes', pg_total_relation_size(c.oid),
                                            'rows', s.n_live_tup) order by pg_total_relation_size(c.oid) desc)
        from (select c.oid, c.relname, c.relnamespace from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              where c.relkind = 'r' and n.nspname in ('pdm','pm','games','notify','support')
              order by pg_total_relation_size(c.oid) desc limit 8) c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_stat_user_tables s on s.relid = c.oid)),
    'storage', jsonb_build_object(
      'bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects),
      'objects', (select count(*) from storage.objects)),
    'cron', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'last_status', r.status, 'last_start', r.start_time,
        'last_ms', extract(epoch from (r.end_time - r.start_time)) * 1000) order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (select status, start_time, end_time from cron.job_run_details
                         where jobid = j.jobid order by start_time desc limit 1) r on true),
    'vaults', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', v.name,
        'files', (select count(*) from pdm.files f where f.vault_id = v.id and f.deleted_at is null),
        'versions', (select count(*) from pdm.versions x join pdm.files f on f.id = x.file_id where f.vault_id = v.id),
        'bytes', (select coalesce(sum(x.size_bytes),0) from pdm.versions x join pdm.files f on f.id = x.file_id where f.vault_id = v.id),
        'locks', (select count(*) from pdm.locks l join pdm.files f on f.id = l.file_id where f.vault_id = v.id and l.released_at is null),
        'actions_7d', (select count(*) from pdm.audit_log a
                       left join pdm.files af on af.id = nullif(a.payload->>'file_id','')::uuid
                       where a.ts >= now() - interval '7 days'
                         and coalesce(nullif(a.payload->>'vault_id','')::uuid, af.vault_id) = v.id)
      ) order by v.name), '[]'::jsonb)
      from pdm.vaults v)
  ) into out;
  return out;
end; $$;

create or replace function pdm.admin_ops_series(p_days integer default 90)
returns setof pdm.ops_daily
language plpgsql stable security definer
set search_path = pdm, public
as $$
begin
  if not pdm.is_global_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- Finalized days only. The live "today" row comes from admin_ops_overview()
  -- (computed once per refresh) and the client appends it; a manual
  -- ops_snapshot(current_date) therefore can never double up today's point.
  return query
    select * from pdm.ops_daily
    where day >= (now() at time zone 'utc')::date - greatest(p_days, 1)
      and day < (now() at time zone 'utc')::date
    order by day;
end; $$;

create or replace function pdm.admin_ops_people()
returns table (
  user_id uuid, email text, display_name text, subteam text, role text,
  created_at timestamptz, last_sign_in_at timestamptz, last_active timestamptz,
  online boolean, vault_actions_30d integer, pm_actions_30d integer, games_30d integer
)
language plpgsql stable security definer
set search_path = pdm, public, auth, pm, games
as $$
begin
  if not pdm.is_global_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    with last_seen as (
      select s.user_id, max(greatest(coalesce(s.refreshed_at at time zone 'utc', '-infinity'::timestamptz), s.created_at)) as ts
      from auth.sessions s group by s.user_id
    ), va as (
      select a.user_id, count(*)::int as n from pdm.audit_log a where a.ts >= now() - interval '30 days' group by a.user_id
    ), pa as (
      select a.actor_id as user_id, count(*)::int as n from pm.activity a where a.created_at >= now() - interval '30 days' group by a.actor_id
    ), ga as (
      select x.user_id, count(*)::int as n from (
        select b.user_id from games.bets b where b.created_at >= now() - interval '30 days'
        union all
        select sc.user_id from games.scores sc where sc.created_at >= now() - interval '30 days') x group by x.user_id
    )
    select u.id, u.email::text,
      (u.raw_user_meta_data->>'display_name')::text,
      (u.raw_user_meta_data->>'subteam')::text,
      r.role, u.created_at, u.last_sign_in_at,
      greatest(ls.ts, u.last_sign_in_at) as last_active,
      coalesce(ls.ts >= now() - interval '10 minutes', false) as online,
      coalesce(va.n, 0), coalesce(pa.n, 0), coalesce(ga.n, 0)
    from auth.users u
    left join pdm.user_roles r on r.user_id = u.id and r.vault_id is null
    left join last_seen ls on ls.user_id = u.id
    left join va on va.user_id = u.id
    left join pa on pa.user_id = u.id
    left join ga on ga.user_id = u.id
    order by greatest(ls.ts, u.last_sign_in_at) desc nulls last;
end; $$;

create or replace function pdm.admin_ops_hourly()
returns table (source text, dow integer, hour integer, n integer)
language plpgsql stable security definer
set search_path = pdm, public, pm, games
as $$
begin
  if not pdm.is_global_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- Tagged by source so the client can show work (vault + pm) apart from games:
  -- a plinko grinder can log hundreds of bets a day and would otherwise wash
  -- out the picture of when engineering actually happens.
  return query
    select x.src, extract(isodow from x.t)::int - 1, extract(hour from x.t)::int, count(*)::int
    from (
      select 'vault'::text as src, ts as t from pdm.audit_log where ts >= now() - interval '30 days'
      union all select 'pm', created_at from pm.activity where created_at >= now() - interval '30 days'
      union all select 'games', created_at from games.bets where created_at >= now() - interval '30 days'
      union all select 'games', created_at from games.scores where created_at >= now() - interval '30 days'
    ) x
    group by 1, 2, 3;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. House proxies + grants (pdm.pdm_* and public.pdm_*; authenticated only)
-- ---------------------------------------------------------------------------
create or replace function pdm.pdm_admin_ops_overview() returns jsonb
language sql stable security definer set search_path = pdm, public as $$ select pdm.admin_ops_overview(); $$;
create or replace function public.pdm_admin_ops_overview() returns jsonb
language sql stable security definer set search_path = pdm, public as $$ select pdm.admin_ops_overview(); $$;

create or replace function pdm.pdm_admin_ops_series(p_days integer default 90) returns setof pdm.ops_daily
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_series(p_days); $$;
create or replace function public.pdm_admin_ops_series(p_days integer default 90) returns setof pdm.ops_daily
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_series(p_days); $$;

create or replace function pdm.pdm_admin_ops_people()
returns table (user_id uuid, email text, display_name text, subteam text, role text,
  created_at timestamptz, last_sign_in_at timestamptz, last_active timestamptz,
  online boolean, vault_actions_30d integer, pm_actions_30d integer, games_30d integer)
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_people(); $$;
create or replace function public.pdm_admin_ops_people()
returns table (user_id uuid, email text, display_name text, subteam text, role text,
  created_at timestamptz, last_sign_in_at timestamptz, last_active timestamptz,
  online boolean, vault_actions_30d integer, pm_actions_30d integer, games_30d integer)
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_people(); $$;

create or replace function pdm.pdm_admin_ops_hourly() returns table (source text, dow integer, hour integer, n integer)
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_hourly(); $$;
create or replace function public.pdm_admin_ops_hourly() returns table (source text, dow integer, hour integer, n integer)
language sql stable security definer set search_path = pdm, public as $$ select * from pdm.admin_ops_hourly(); $$;

do $$
declare f text;
begin
  foreach f in array array[
    'pdm.admin_ops_overview()', 'pdm.admin_ops_series(integer)', 'pdm.admin_ops_people()', 'pdm.admin_ops_hourly()',
    'pdm.pdm_admin_ops_overview()', 'pdm.pdm_admin_ops_series(integer)', 'pdm.pdm_admin_ops_people()', 'pdm.pdm_admin_ops_hourly()',
    'public.pdm_admin_ops_overview()', 'public.pdm_admin_ops_series(integer)', 'public.pdm_admin_ops_people()', 'public.pdm_admin_ops_hourly()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
