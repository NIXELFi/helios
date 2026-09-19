-- 20260919000100_sim_runs_profile.sql
--
-- What a shared run was driven WITH.
--
-- The boards are compared within a device class, because across one they do
-- not compare: a wheel has a real stop at a real angle and two hundred times
-- the resolution of a stick, and a keyboard is a switch that software ramps
-- into a steering command. A single list of all three does not rank drivers,
-- it ranks hardware.
--
-- The manifest has always carried this; the shared row did not, so a
-- teammate's run arrived with no way to tell which board it belonged on.

alter table sim.runs add column if not exists profile text;

-- The board filters on it, per course.
create index if not exists idx_sim_runs_track_profile_best
  on sim.runs (track, profile, best_lap_s)
  where best_lap_s is not null and synthetic = false;
