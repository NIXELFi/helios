-- Tetris joins the arcade (in-app feature request 7158006c, 2026-10-16).
--
-- games.scores only accepts the game ids in its check constraint, so the new
-- cabinet needs 'tetris' added there, plus a plausibility rule in the spirit of
-- 20260829000000_games_score_hardening: the engine (apps/desktop/src/modules/
-- games/games/tetris/logic.ts) scores line clears only — 100/300/500/800 x
-- level, no drop points — so every legitimate score is a multiple of 100.
--
-- Hosted migration history is drifted: apply via the Management API query
-- endpoint and record the version by hand. Do NOT db push.

alter table games.scores drop constraint if exists scores_game_id_check;
alter table games.scores
  add constraint scores_game_id_check
  check (game_id in ('snake','breakout','flappy','2048','tetris','blackjack'));

alter table games.scores drop constraint if exists scores_value_plausible;
alter table games.scores
  add constraint scores_value_plausible
  check (
    case game_id
      when '2048'     then score % 4 = 0 and score <= 4000000
      when 'breakout' then score % 10 = 0
      when 'snake'    then score <= 400
      when 'flappy'   then score <= 10000
      when 'tetris'   then score % 100 = 0
      else true
    end
  ) not valid;
