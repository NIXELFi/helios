-- Hotfix: plinko_drop could never complete a drop in production.
--
-- 20260825000000 created games.plinko_drop with
--   set search_path = games, public, auth
-- but the function calls gen_random_bytes() to generate the ball's path, and
-- gen_random_bytes is a pgcrypto function. Supabase installs pgcrypto into the
-- "extensions" schema, which was not on that search_path — so every drop failed
-- at run time with:
--
--   ERROR: 42883: function gen_random_bytes(integer) does not exist
--
-- Nothing else was affected: plinko_drop is the only routine in the games schema
-- that touches pgcrypto, and the gen_random_uuid() used for table defaults is
-- core Postgres (it resolves from pg_catalog), so the tables gave no warning.
--
-- This is an ALTER rather than a CREATE OR REPLACE on purpose: the body is
-- correct and 150 lines long, and only the search_path was ever wrong.
-- 20260825000000 has been corrected in place too, so a fresh deployment builds
-- the function right the first time and this migration is a no-op for it.
--
-- Matches the existing convention in 20260617007000_pm_gcal_sync.sql, where
-- pm.sync_gcal() uses `set search_path = pm, public, extensions`.

alter function games.plinko_drop(p_rows integer, p_risk text, p_stake bigint, p_nonce text)
  set search_path = games, public, auth, extensions;
