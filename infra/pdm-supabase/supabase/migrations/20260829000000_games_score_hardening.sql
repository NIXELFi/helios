-- Hardening after the 2026-08-28 score-fabrication incident (direct PostgREST
-- inserts with hand-picked score values, bypassing the game clients).
--
-- Both constraints are NOT VALID: they bind new inserts/updates only, so the
-- legacy pre-nonce rows (before 20260622000700) never need backfilling.
-- The pre-existing rows that VIOLATE these invariants (the incident's
-- fabricated scores) were deleted out-of-band with the service role on
-- 2026-08-28, with a full table backup taken first — so the boards this
-- migration protects were also already clean when it landed.
--
-- Applied to hosted via MCP apply_migration on 2026-08-28; this file is the
-- repo record (hosted migration history is drifted, do not db push).

-- Every current client mints a submission_nonce per play; a missing nonce only
-- ever comes from out-of-client writes.
alter table games.scores
  add constraint scores_submission_nonce_required
  check (submission_nonce is not null) not valid;

-- Score values the game engines cannot produce:
--   2048:     every gain is a merged tile (multiple of 4); 4M > theoretical max
--   breakout: bricks are +10, level bonus +50 -> always a multiple of 10
--   snake:    20x20 grid caps food eaten at < 400
--   flappy:   +1 per pipe at ~1.5 s/pipe; 10k = ~4 h of perfect play
--   blackjack (and future games): no proven invariant, left unconstrained
alter table games.scores
  add constraint scores_value_plausible
  check (
    case game_id
      when '2048'     then score % 4 = 0 and score <= 4000000
      when 'breakout' then score % 10 = 0
      when 'snake'    then score <= 400
      when 'flappy'   then score <= 10000
      else true
    end
  ) not valid;
