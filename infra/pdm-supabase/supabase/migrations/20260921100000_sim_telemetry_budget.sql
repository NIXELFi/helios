-- 20260921100000_sim_telemetry_budget.sql
--
-- Helios Sim module — a ceiling on what the team's telemetry costs.
--
-- The retention rule in the client (`telemetryToKeep`) is a rule about what a
-- DRIVER keeps: best three and latest three per fixed course, best two and
-- latest one on a generated one. It is the right rule and it is not a ceiling.
-- It runs only where a driver is signed in, so a member who graduates leaves
-- their objects behind for good; and it is per course, so it bounds a course
-- rather than a bucket.
--
-- This is the other half: one job, judging the bucket, deleting in an order
-- that is written down.
--
-- ROWS ARE NEVER DELETED. Only blobs. A time stays on the board permanently --
-- at 1.3 kB a row, fifty thousand runs is 65 MB of database, and the history
-- is the part worth keeping. What goes is the replay, which is megabytes.
--
-- It ships INERT: the budget is seeded far above anything reachable, so the
-- job runs nightly, writes a log line and deletes nothing. A later statement
-- lowers it once a few nights have been read. The first time this deletes
-- something should not also be the first time it runs.

-- =============================================================================
-- THE TOMBSTONE
-- =============================================================================
--
-- Without this the cap cannot hold. `pushRuns` uploads anything in its keep
-- set that has no object, so a lap deleted at three in the morning is back at
-- the next sign-in and the bucket oscillates at the cap indefinitely -- the
-- job deleting and the rig replacing the same megabytes every night, for ever.
-- The client reads this column and declines. Clearing it shares the lap again,
-- which is a deliberate act and stays possible.

alter table sim.runs add column if not exists evicted_at timestamptz;

comment on column sim.runs.evicted_at is
  'When sim.enforce_telemetry_budget removed this run''s lap. The client will '
  'not re-upload while it is set; clearing it shares the lap again.';

-- =============================================================================
-- CONFIG AND LOG
-- =============================================================================

create table if not exists sim.telemetry_budget (
  id            integer primary key default 1,
  budget_bytes  bigint not null,
  -- Where the storage API lives. Deliberately not in vault: it is not a
  -- secret, and a config row is where somebody will think to look for it.
  base_url      text   not null,
  -- Belt and braces against a mistake in a later migration or a stray UPDATE.
  -- A budget of zero would delete every evictable lap the team has on its
  -- first run, and there would be no undo.
  floor_bytes   bigint not null default 1073741824,
  updated_at    timestamptz not null default now(),
  constraint telemetry_budget_singleton check (id = 1),
  constraint telemetry_budget_sane check (budget_bytes >= floor_bytes)
);

insert into sim.telemetry_budget (id, budget_bytes, base_url)
values (1, 1125899906842624, 'https://dlmyixonuyckxkknolku.supabase.co')
on conflict (id) do nothing;

create table if not exists sim.telemetry_budget_log (
  id            bigserial primary key,
  ran_at        timestamptz not null default now(),
  bytes_before  bigint not null,
  bytes_after   bigint not null,
  budget_bytes  bigint not null,
  deleted       integer not null default 0,
  note          text
);

create index if not exists idx_sim_budget_log_ran on sim.telemetry_budget_log (ran_at desc);

-- =============================================================================
-- THE ORDER
-- =============================================================================
--
-- Every shared object, with the tier that decides when it goes and the keys
-- that order it within its tier. Read top to bottom; delete until under.
--
--   1  in no keep set at all -- the client should have pruned it and has not
--   2  held only by a RECENT slot: the lap you threw away, on any course
--   3  a generated course's best laps, oldest SEED first
--   4  a fixed course's second and third best, worst first
--   0  a driver's BEST on a fixed course: never, at any pressure
--
-- GENERATED SEEDS GO BEFORE FIXED-COURSE EXTRAS, not after. Tier 2 has already
-- taken the recency dimension, so what survives into 3 and 4 is best-laps
-- only; and among best-laps, a second-best on the 2026 autocross course is
-- worth more than the best lap on a seed somebody typed once and will not load
-- again.
--
-- Tier 4 orders by PERCENTAGE OFF THAT COURSE'S RECORD, not by lap time. An
-- endurance lap is ~90 s and an autocross lap ~43 s, so a global sort by raw
-- time would delete every endurance ghost on the system before it touched a
-- single autocross lap -- which is not "the worst times first", it is "the
-- longest courses first".

create or replace view sim.telemetry_eviction_order as
with shared as (
  select
    r.run_id, r.user_id, r.track, r.started_at, r.best_lap_s,
    r.telemetry_object, coalesce(r.telemetry_bytes, 0) as bytes,
    (r.track like 'gen-a%' or r.track like 'gen-e%') as generated,
    -- The same predicate the client's `isRankable` applies, so the two agree
    -- about which laps are benchmarks. A lap with an aid on is not one.
    (not r.synthetic
     and r.best_lap_s is not null
     and not coalesce((r.assists->>'traction')::boolean, false)
     and not coalesce((r.assists->>'abs')::boolean, false)
     and not coalesce((r.assists->>'autoShift')::boolean, false)) as rankable
  from sim.runs r
  where r.telemetry_object is not null
),
ranked as (
  select s.*,
    case when s.rankable then
      row_number() over (
        partition by s.user_id, s.track, s.rankable
        order by s.best_lap_s, s.run_id)
    end as best_rank,
    row_number() over (
      partition by s.user_id, s.track
      order by s.started_at desc nulls last, s.run_id desc) as recent_rank,
    min(s.best_lap_s) filter (where s.rankable) over (partition by s.track) as course_record,
    min(s.started_at) over (partition by s.track) as seed_first_seen
  from shared s
),
classed as (
  select r.*,
    (r.best_rank is not null
      and r.best_rank <= case when r.generated then 2 else 3 end) as in_best,
    (r.recent_rank <= case when r.generated then 1 else 3 end) as in_recent
  from ranked r
)
select
  c.run_id, c.user_id, c.track, c.telemetry_object, c.bytes,
  c.started_at, c.best_lap_s, c.best_rank, c.generated,
  case
    when not c.generated and c.best_rank = 1 then 0   -- never evicted
    when not c.in_best and not c.in_recent  then 1
    when c.in_recent and not c.in_best      then 2
    when c.generated                        then 3
    else                                         4
  end as tier,
  c.seed_first_seen,
  case when c.course_record > 0
       then (c.best_lap_s / c.course_record) - 1 end as pct_off_record
from classed c;

comment on view sim.telemetry_eviction_order is
  'Every shared telemetry object with the tier and keys that decide when it is '
  'deleted. Tier 0 is never evicted: a driver''s own best on a fixed course.';

-- =============================================================================
-- THE JOB
-- =============================================================================
--
-- SYNCHRONOUS deletes, through the `http` extension rather than `pg_net`. The
-- pointer and the bytes have to agree: marking a row's lap gone on the
-- strength of a request nobody acknowledged loses the pointer while the object
-- stays, and from then on nothing can reach it -- the download reads the
-- pointer, and so does every prune. `http` returns the status in the same
-- statement, so a row is marked only for a delete that actually happened.
--
-- AND DELETING FROM storage.objects DIRECTLY WOULD NOT DO. It removes the
-- metadata row and leaves the file in S3: unreachable AND uncounted, which is
-- strictly worse than leaving it alone, because the next run of this job
-- cannot even see the bytes it failed to free. The Storage API is the only
-- thing that removes both halves.

create extension if not exists http with schema extensions;

create or replace function sim.enforce_telemetry_budget(p_dry_run boolean default false)
returns sim.telemetry_budget_log
language plpgsql
security definer
set search_path = sim, storage, extensions, vault, public
as $$
declare
  cfg       sim.telemetry_budget;
  v_key     text;
  v_before  bigint;
  v_total   bigint;
  v_deleted int := 0;
  v_note    text := null;
  v_batch   text[];
  v_ids     text[];
  -- Every run this call has already dealt with.
  --
  -- Two jobs. It makes the DRY RUN honest: nothing is really deleted then, so
  -- the view hands back the same candidates on the next turn and the estimate
  -- counts them twice -- which it did, reporting nine objects gone from a
  -- bucket of nine of which one may never be touched, and a negative total.
  -- And it makes the loop terminate unconditionally rather than because the
  -- UPDATE below is expected to shrink the view.
  v_seen    text[] := '{}';
  v_freed   bigint;
  v_status  int;
  v_body    text;
  v_log     sim.telemetry_budget_log;
begin
  select * into cfg from sim.telemetry_budget where id = 1;
  if cfg.id is null then
    raise exception 'sim.telemetry_budget has no row';
  end if;

  select coalesce(sum((metadata->>'size')::bigint), 0) into v_before
    from storage.objects where bucket_id = 'sim-telemetry';
  v_total := v_before;

  if v_total <= cfg.budget_bytes then
    insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
    values (v_before, v_total, cfg.budget_bytes, 0, 'under budget')
    returning * into v_log;
    return v_log;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'sim_storage_service_key';
  if v_key is null and not p_dry_run then
    -- Over budget and unable to act is worth a log line rather than an
    -- exception: cron swallows the exception, and then nobody knows.
    insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
    values (v_before, v_total, cfg.budget_bytes, 0,
            'OVER BUDGET and cannot act: vault has no sim_storage_service_key')
    returning * into v_log;
    return v_log;
  end if;

  -- In batches, because the Storage API takes a list of prefixes and one round
  -- trip per object would be thousands of them.
  --
  -- The batch is cut to what the overage actually needs, not taken whole. A
  -- fixed hundred-object batch deletes a hundred laps to recover the last
  -- megabyte over the line: at a few megabytes each that is most of a
  -- gigabyte of replays thrown away to free almost nothing, and the ones at
  -- the end of a batch are always the most valuable in it -- that is what the
  -- ordering means. `running - bytes < overage` keeps a row only while
  -- everything ahead of it was still not enough.
  loop
    exit when v_total <= cfg.budget_bytes;

    select array_agg(telemetry_object order by ord),
           array_agg(run_id order by ord),
           sum(bytes)
      into v_batch, v_ids, v_freed
    from (
      select q.run_id, q.telemetry_object, q.bytes, q.ord,
             sum(q.bytes) over (order by q.ord rows unbounded preceding) as running
      from (
        select e.run_id, e.telemetry_object, e.bytes,
               row_number() over (
                 order by e.tier,
                          -- tiers 1 and 2: oldest first
                          case when e.tier in (1, 2) then e.started_at end asc nulls first,
                          -- tier 3: oldest SEED first, then oldest run within it
                          case when e.tier = 3 then e.seed_first_seen end asc nulls first,
                          case when e.tier = 3 then e.started_at end asc nulls first,
                          -- tier 4: third best before second best, worst first
                          case when e.tier = 4 then e.best_rank end desc nulls last,
                          case when e.tier = 4 then e.pct_off_record end desc nulls last,
                          e.run_id
               ) as ord
        from sim.telemetry_eviction_order e
        where e.tier > 0
          and not (e.run_id = any (v_seen))
      ) q
    ) r
    where r.ord <= 100
      and r.running - r.bytes < (v_total - cfg.budget_bytes);

    if v_batch is null or array_length(v_batch, 1) = 0 then
      v_note := format(
        'OVER BUDGET with nothing left to evict: %s bytes remain and all of them are '
        'protected best laps; budget is %s. Raise the budget or revisit the rule.',
        v_total, cfg.budget_bytes);
      exit;
    end if;

    v_seen := v_seen || v_ids;

    if p_dry_run then
      v_deleted := v_deleted + array_length(v_batch, 1);
      v_total := v_total - coalesce(v_freed, 0);
      v_note := coalesce(v_note, '')
        || format('dry run: would delete %s object(s); ', array_length(v_batch, 1));
      continue;
    end if;

    select status, content into v_status, v_body
      from extensions.http((
        'DELETE',
        cfg.base_url || '/storage/v1/object/sim-telemetry',
        array[
          extensions.http_header('authorization', 'Bearer ' || v_key),
          extensions.http_header('apikey', v_key)
        ],
        'application/json',
        json_build_object('prefixes', v_batch)::text
      )::extensions.http_request);

    if v_status is distinct from 200 then
      -- Say nothing to the rows. The objects are still there, the pointers
      -- still reach them, and tomorrow night tries again.
      v_note := format('storage delete failed: HTTP %s %s',
                       v_status, left(coalesce(v_body, ''), 300));
      exit;
    end if;

    -- Only now, and only for what the API acknowledged.
    update sim.runs
       set telemetry_object = null,
           telemetry_bytes  = null,
           evicted_at       = now()
     where run_id = any (v_ids);

    v_deleted := v_deleted + array_length(v_batch, 1);
    v_total := v_total - coalesce(v_freed, 0);
  end loop;

  insert into sim.telemetry_budget_log (bytes_before, bytes_after, budget_bytes, deleted, note)
  values (v_before, v_total, cfg.budget_bytes, v_deleted, v_note)
  returning * into v_log;
  return v_log;
end;
$$;

-- Nobody but the scheduler. The function reads a service-role key out of
-- vault, so `security definer` plus the default public grant would hand every
-- signed-in member a way to delete the whole team's telemetry.
revoke all on function sim.enforce_telemetry_budget(boolean) from public;
revoke all on function sim.enforce_telemetry_budget(boolean) from authenticated;
revoke all on function sim.enforce_telemetry_budget(boolean) from anon;

-- Same reasoning for the view and the config: the view names every driver's
-- objects, and nothing in the app has any business writing the budget.
revoke all on sim.telemetry_eviction_order from authenticated, anon;
revoke all on sim.telemetry_budget from authenticated, anon;

-- The log is worth reading from the app -- "why did my lap go" deserves an
-- answer -- and carries nothing private.
grant select on sim.telemetry_budget_log to authenticated;

alter table sim.telemetry_budget_log enable row level security;
drop policy if exists budget_log_read_authed on sim.telemetry_budget_log;
create policy budget_log_read_authed on sim.telemetry_budget_log
  for select to authenticated
  using (true);

-- Nightly, twenty minutes after the ops snapshot so the two do not overlap.
select cron.unschedule('sim-telemetry-budget')
  where exists (select 1 from cron.job where jobname = 'sim-telemetry-budget');
select cron.schedule('sim-telemetry-budget', '30 0 * * *',
                     $cron$select sim.enforce_telemetry_budget();$cron$);
