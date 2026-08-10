-- 20260810000000_games_blackjack_game_id.sql
--
-- Casino section of the Games tab: allow 'blackjack' as a games.scores
-- game_id. The score submitted for blackjack is the session-end Elo rating
-- (rated per hand against a fixed-1000 house), not a chip count — same
-- integer >= 0 shape as every other game, so the leaderboard views and the
-- Grand Prix placement scoring need no changes.
--
-- The registry test (apps/desktop .../games/__tests__/registry.test.ts)
-- keeps the client id list in lockstep with this constraint.

alter table games.scores
  drop constraint scores_game_id_check;

alter table games.scores
  add constraint scores_game_id_check
  check (game_id in ('snake','breakout','flappy','2048','blackjack'));
