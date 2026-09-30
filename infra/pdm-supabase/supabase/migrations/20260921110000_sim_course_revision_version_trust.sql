-- 20260921110000_sim_course_revision_version_trust.sql
--
-- Helios Sim module — a version is only evidence if it names a build that
-- existed.
--
-- `sim.run_predates_course` decides whether a run was driven on a course that
-- has since changed shape, and it decided on the simulator version whenever
-- the run carried one. That made the rule exactly as trustworthy as the
-- version field, and the field was a lie: the simulator stamped the
-- hand-written literal `1.0.0` into every manifest while it actually shipped
-- 0.2.0 and then 0.3.0, until 2026-09-19 09:55 UTC. See the simulator's commit
-- "Every run ever recorded claims a version that has never existed".
--
-- 1.0.0 sorts above the 0.6.0 revision, so twenty-five runs driven on
-- 2026-09-19 -- two days before the autocross course gained its slaloms --
-- were judged NEWER than the change and left on the board. The quickest was a
-- 38.979 through open road, against real times on the slalomed course of 42+,
-- so it sat on top of the leaderboard and stayed there through the purge that
-- was supposed to clear exactly this.
--
-- So: believe the version only when it names a build that has plausibly
-- shipped, and otherwise fall back to the date, which is what this already did
-- for rows carrying no version at all.
--
-- NOT a blacklist of '1.0.0'. The simulator will reach 1.0.0 honestly one day
-- and those runs must rank -- they will, because their dates fall after every
-- revision. What condemns these is the date, not the string.
--
-- And deliberately NOT "an old date is enough on its own", which was the first
-- thing tried. A build is routinely driven before it is published: the 0.6.2
-- runs on the board were set 47 minutes after 0.6.0 went up, so a date-first
-- rule condemns a maintainer's own laps on a build that had the current course
-- all along.

create or replace function sim.run_predates_course(
  p_track text, p_started_at timestamptz, p_stats jsonb
) returns boolean
language plpgsql
immutable
as $$
declare
  rev_at  timestamptz;
  rev_ver int[];
  -- The newest simulator version known to have been released. Going stale is
  -- SAFE: a run claiming something newer is judged on its date instead, and a
  -- genuinely newer build's runs are dated after every revision, so they rank
  -- either way. What this buys is the other direction -- an impossibly high
  -- version on an old run stops being taken at its word.
  newest  int[] := array[0, 6, 6];
  v       text;
  parts   int[];
begin
  if p_track = 'autocross' then
    rev_at := '2026-09-21T01:10:00Z'; rev_ver := array[0, 6, 0];
  elsif p_track = 'endurance' then
    rev_at := '2026-09-21T01:28:00Z'; rev_ver := array[0, 6, 1];
  else
    return false;
  end if;

  v := regexp_replace(coalesce(p_stats->>'simVersion', ''), '^fsae-sim\s+', '');
  if v ~ '^\d+\.\d+' then
    select array_agg(x::int order by ord) into parts
      from unnest(string_to_array(split_part(v, '-', 1), '.')) with ordinality as u(x, ord)
      where x ~ '^\d+$';
    -- Believable: at or below the newest build that has shipped. Equal counts,
    -- and is the common case for anybody who is up to date.
    if parts is not null and parts <= newest then
      return parts < rev_ver;
    end if;
  end if;

  if p_started_at is null then
    return true;
  end if;
  return p_started_at < rev_at;
end;
$$;

-- And clear what the old rule let through.
--
-- `pushRuns` skips stale runs, so a rig still holding these will not put them
-- back, and the local copies stay on the drivers' own machines -- which is
-- where the archive lives anyway. Only the team's copy goes.
--
-- THE LAPS GO WITH THE ROWS. A plain `delete from sim.runs` orphans whatever
-- telemetry those rows pointed at: the object stays in the bucket with nothing
-- naming it, unreachable by the download (which reads the pointer) and by the
-- retention prune (which reads the pointer too). The previous revision purge
-- did exactly that. Storage is the one thing SQL cannot roll back, so the
-- objects go first and the rows only if that was acknowledged.
--
-- If the vault secret is missing the rows still go and the objects are left
-- for `pushRuns`'s sweep, which collects anything in a driver's folder that no
-- row points at. That is slower -- it waits for the driver to sign in -- but
-- it is not a leak.
do $$
declare
  cfg      sim.telemetry_budget;
  v_key    text;
  v_objs   text[];
  v_status int;
begin
  select array_agg(telemetry_object) into v_objs
    from sim.runs
   where telemetry_object is not null
     and sim.run_predates_course(track, started_at, stats);

  if v_objs is not null and array_length(v_objs, 1) > 0 then
    select * into cfg from sim.telemetry_budget where id = 1;
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'sim_storage_service_key';

    if v_key is null or cfg.base_url is null then
      raise notice 'no storage credentials: leaving % object(s) for the client sweep',
        array_length(v_objs, 1);
    else
      select status into v_status
        from extensions.http((
          'DELETE',
          cfg.base_url || '/storage/v1/object/sim-telemetry',
          array[extensions.http_header('authorization', 'Bearer ' || v_key),
                extensions.http_header('apikey', v_key)],
          'application/json',
          json_build_object('prefixes', v_objs)::text
        )::extensions.http_request);
      if v_status is distinct from 200 then
        raise exception 'could not remove % stale lap(s) from storage: HTTP %',
          array_length(v_objs, 1), v_status;
      end if;
      raise notice 'removed % stale lap(s) from storage', array_length(v_objs, 1);
    end if;
  end if;
end $$;

delete from sim.runs where sim.run_predates_course(track, started_at, stats);
