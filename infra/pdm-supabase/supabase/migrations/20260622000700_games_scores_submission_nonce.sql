-- Audit fix (v4 bug vault, frontend/games): "Retry submit can insert duplicate
-- score rows on flaky network".
--
-- The client now mints a per-play idempotency nonce and reuses it on every
-- retry of the same game-over submission. Back it with a real column + unique
-- index so a retry that already committed the row is collapsed server-side
-- (the client upserts with ON CONFLICT DO NOTHING against this index).
--
-- NULLs are distinct in a standard unique index, so the legacy / no-nonce
-- insert path is unaffected (multiple null-nonce rows remain allowed). The
-- identity-stamping BEFORE INSERT trigger does not touch submission_nonce, so
-- the client-supplied value passes through unchanged.

alter table games.scores
  add column if not exists submission_nonce uuid;

create unique index if not exists games_scores_user_game_nonce_uniq
  on games.scores (user_id, game_id, submission_nonce);
