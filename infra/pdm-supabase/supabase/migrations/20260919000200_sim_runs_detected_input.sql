-- 20260919000200_sim_runs_detected_input.sql
--
-- What a shared run was actually driven with, as opposed to what its driver
-- said.
--
-- `profile` (the previous migration) is the control profile picked from a
-- dropdown in the simulator's settings. The boards are separated by device
-- class, and separating them by a dropdown separates them by a claim: the
-- controller profile reads an axis, a wheel base has axes, so "pick
-- Controller, steer the wheel anyway" hands the controller record to whoever
-- owns a wheel.
--
-- `detected_input` is written by the branch of the simulator's input loop that
-- produced the steering command, frame by frame, and it asks the DEVICE --
-- a base the rig opened for force feedback, or a vendor string that names a
-- wheel -- not the profile. One of 'wheel', 'controller', 'keyboard', or null
-- on a run recorded before the simulator measured it.
--
-- Not tamper proof: the manifest is a JSON file on the driver's own machine.
-- It closes the cheat that costs nothing, which is the one that would happen.

alter table sim.runs add column if not exists detected_input text;

alter table sim.runs drop constraint if exists sim_runs_detected_input_check;
alter table sim.runs add constraint sim_runs_detected_input_check
  check (detected_input is null or detected_input in ('wheel', 'controller', 'keyboard'));

-- The board filters on it, per course. Replaces the profile index: the profile
-- is still stored and still shown, but nothing ranks by it any more.
create index if not exists idx_sim_runs_track_input_best
  on sim.runs (track, detected_input, best_lap_s)
  where best_lap_s is not null and synthetic = false;
