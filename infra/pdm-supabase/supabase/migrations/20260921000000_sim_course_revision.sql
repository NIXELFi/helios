-- 20260921000000_sim_course_revision.sql
--
-- Helios Sim module — a course that changed shape keeps no old times.
--
-- The 2026 autocross and endurance courses gained their slaloms (from the
-- published course maps) in simulator 0.6.0, published 2026-09-20 18:10
-- Arizona time; endurance gained its third slalom in 0.6.1 at 18:28. Every
-- time set before that was driven on a different course, so the board was
-- cleared of them. This keeps them out: whatever client pushes a run on one
-- of those courses from before its revision -- an un-updated Helios syncing
-- an old local archive is exactly the case -- the row is dropped, silently,
-- so the old client does not error and retry. Helios 5.9.0 applies the same
-- rule on its side (`predatesCourse`) and this is the copy that does not
-- depend on anyone updating.
--
-- Judged by the simulator version the row carries in `stats.simVersion`
-- (Helios 5.9.0 sends it) and by `started_at` otherwise. Version first: a
-- rig still on 0.5.7 driving after the cutoff is still on the old course.

create or replace function sim.run_predates_course(
  p_track text, p_started_at timestamptz, p_stats jsonb
) returns boolean
language plpgsql
immutable
as $$
declare
  rev_at  timestamptz;
  rev_ver int[];
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
    select array_agg(x::int) into parts
      from unnest(string_to_array(split_part(v, '-', 1), '.')) as x
      where x ~ '^\d+$';
    return parts < rev_ver;
  end if;
  if p_started_at is null then
    return true;
  end if;
  return p_started_at < rev_at;
end;
$$;

create or replace function sim.drop_stale_run()
returns trigger
language plpgsql
as $$
begin
  if sim.run_predates_course(new.track, new.started_at, new.stats) then
    return null; -- skip the write; nothing to say to the client
  end if;
  return new;
end;
$$;

-- Runs before runs_stamp_identity (triggers fire in name order), so a stale
-- row is dropped before identity is even looked at.
drop trigger if exists runs_drop_stale on sim.runs;
create trigger runs_drop_stale
  before insert or update on sim.runs
  for each row execute function sim.drop_stale_run();

-- And anything that got in before this did.
delete from sim.runs where sim.run_predates_course(track, started_at, stats);
