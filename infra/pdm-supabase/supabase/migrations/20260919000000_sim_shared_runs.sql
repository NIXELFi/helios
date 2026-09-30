-- 20260919000000_sim_shared_runs.sql
--
-- Helios Sim module — runs shared across the team.
--
-- Until now the sim archive was local files and nothing else: every Helios
-- read `%LOCALAPPDATA%\Helios\sim-runs` on its own machine, so the
-- "leaderboard" was a leaderboard of whoever had driven at that rig. Local
-- first is right -- a test day has no network and the simulator must not care
-- -- but it was only half of it.
--
-- So: one row per run, pushed by the driver's own Helios when it has a
-- connection, read by everybody. The local files stay the source of truth and
-- the source of the replay; this is the part that travels.
--
-- IDENTITY IS STAMPED SERVER-SIDE, exactly as games.scores does it. A client
-- cannot post a lap time under somebody else's name, which is the only thing
-- that makes a leaderboard worth having. `driver` (what the simulator wrote
-- into the manifest) is kept alongside `display_name` (what Helios knows the
-- account as) precisely so a disagreement is visible rather than papered over.
--
-- THE SHAPE OF A RUN IS NOT FIXED. The simulator's manifest grows -- it has
-- gained a format version, a sample rate, per-lap cones and a reference lap
-- already -- so the columns here are only what the boards actually query and
-- sort on, and `stats` and `laps` carry the rest as jsonb. A new field in the
-- simulator does not need a migration to be visible.
--
-- After applying, add `sim` to the project's exposed schemas
-- (Dashboard -> Project Settings -> API -> Exposed schemas).

create schema if not exists sim;

-- =============================================================================
-- RUNS
-- =============================================================================

create table if not exists sim.runs (
  -- The simulator's own run id: `<yyyymmdd-hhmmss>-<track>-<rand4>`. It is
  -- the primary key so that pushing the same run twice is idempotent -- a rig
  -- that syncs, loses its connection and syncs again must not double-file.
  run_id        text primary key,

  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Stamped by trigger from auth.users.raw_user_meta_data; null = "Unassigned".
  display_name  text,
  subteam       text,
  -- What the SIMULATOR recorded as the driver. Normally the same person; kept
  -- separately so "signed in as one person, recorded as another" is visible.
  driver        text,

  track         text not null,
  track_name    text,
  started_at    timestamptz,

  -- What the boards sort and filter on. Everything else lives in `stats`.
  best_lap_s    double precision,
  laps          integer not null default 0,
  total_cones   integer not null default 0,
  -- Traction control, ABS, automatic gearbox. A time set with any of them on
  -- does not rank; the client owns that rule (one definition, `isRankable`)
  -- and this is here so it can apply it to a run it has never seen locally.
  assists       jsonb not null default '{}'::jsonb,
  -- The robot driver's runs list and replay but never rank.
  synthetic     boolean not null default false,
  -- Before version 2 the sector numbers in `stats` are not sector times at
  -- all. The UI hides them for older runs rather than drawing them.
  format_version integer not null default 1,

  stats         jsonb not null default '{}'::jsonb,
  laps_detail   jsonb not null default '[]'::jsonb,

  -- Where the telemetry sits in the `sim-telemetry` bucket, when it was worth
  -- uploading: `<user_id>/<run_id>.csv.gz`. Null for the great majority of
  -- runs -- only a lap that set a personal best on its course carries one, so
  -- a season of practice does not become a season of megabytes.
  telemetry_object text,
  telemetry_bytes  bigint,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The leaderboard query: quickest first, per course, ignoring the unranked.
create index if not exists idx_sim_runs_track_best
  on sim.runs (track, best_lap_s)
  where best_lap_s is not null and synthetic = false;

-- The runs table: newest first, and "just mine".
create index if not exists idx_sim_runs_started on sim.runs (started_at desc);
create index if not exists idx_sim_runs_user on sim.runs (user_id, started_at desc);

create or replace function sim.stamp_run_identity()
returns trigger
language plpgsql
security definer
set search_path = sim, public, auth
as $$
declare
  meta jsonb;
begin
  -- Force identity server-side; ignore whatever the client sent. A lap time
  -- is a claim about a person, and this is the line that makes it one.
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select raw_user_meta_data into meta from auth.users where id = new.user_id;
  new.subteam      := nullif(meta->>'subteam', '');
  new.display_name := nullif(meta->>'display_name', '');
  new.updated_at   := now();
  return new;
end;
$$;

drop trigger if exists runs_stamp_identity on sim.runs;
create trigger runs_stamp_identity
  before insert or update on sim.runs
  for each row execute function sim.stamp_run_identity();

alter table sim.runs enable row level security;

-- The trigger has already forced user_id = auth.uid() by the time WITH CHECK
-- runs, so these are belt-and-braces -- and the UPDATE policy's USING clause
-- is not: it is what stops an upsert on somebody else's run id from
-- overwriting their time with yours.
drop policy if exists runs_insert_own on sim.runs;
create policy runs_insert_own on sim.runs
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists runs_update_own on sim.runs;
create policy runs_update_own on sim.runs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists runs_delete_own on sim.runs;
create policy runs_delete_own on sim.runs
  for delete to authenticated
  using (user_id = auth.uid());

-- Everyone signed in reads everything. That is the whole point of the table.
drop policy if exists runs_read_authed on sim.runs;
create policy runs_read_authed on sim.runs
  for select to authenticated
  using (true);

grant usage on schema sim to authenticated;
grant select, insert, update, delete on sim.runs to authenticated;

-- =============================================================================
-- TELEMETRY
-- =============================================================================
--
-- PRIVATE, unlike the bucket the simulator's own builds come from. A build is
-- a public artefact; a team's telemetry is not something to leave readable by
-- anyone who can guess a run id. Signed-in members read it through their own
-- token.

insert into storage.buckets (id, name, public)
values ('sim-telemetry', 'sim-telemetry', false)
on conflict (id) do nothing;

drop policy if exists sim_telemetry_read on storage.objects;
create policy sim_telemetry_read on storage.objects
  for select to authenticated
  using (bucket_id = 'sim-telemetry');

-- Write only under your own id: `<user_id>/<run_id>.csv.gz`. Without this a
-- member could overwrite somebody else's lap with their own telemetry and the
-- replay would quietly disagree with the time beside it.
drop policy if exists sim_telemetry_write_own on storage.objects;
create policy sim_telemetry_write_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sim-telemetry'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists sim_telemetry_update_own on storage.objects;
create policy sim_telemetry_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'sim-telemetry'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists sim_telemetry_delete_own on storage.objects;
create policy sim_telemetry_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'sim-telemetry'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
