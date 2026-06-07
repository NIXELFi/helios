-- 20260605000000_games_schema.sql
--
-- Helios Games module — scores table + leaderboard views.
--
-- One row per finished run. Identity (user_id, subteam, display_name) is
-- stamped server-side by a BEFORE INSERT trigger from auth.users metadata —
-- clients cannot read other users' metadata, so denormalizing at write time
-- is what makes the leaderboards queryable. The trigger also overwrites any
-- client-supplied identity values, so a client can only ever submit a score
-- as itself.
--
-- After applying, add `games` to the project's exposed schemas
-- (Dashboard -> Project Settings -> API -> Exposed schemas) so the JS
-- client's client.schema('games') can reach these tables/views.

create schema if not exists games;

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- SCORES
-- =============================================================================

create table games.scores (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  game_id      text not null check (game_id in ('snake','breakout','flappy','2048')),
  score        integer not null check (score >= 0),
  -- Stamped by trigger from auth.users.raw_user_meta_data; null = "Unassigned".
  subteam      text,
  display_name text,
  created_at   timestamptz not null default now()
);

create index idx_games_scores_game_best on games.scores (game_id, score desc);
create index idx_games_scores_game_week on games.scores (game_id, created_at);

create or replace function games.stamp_score_identity()
returns trigger
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  meta jsonb;
begin
  -- Force identity server-side; ignore whatever the client sent.
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select raw_user_meta_data into meta from auth.users where id = new.user_id;
  new.subteam      := nullif(meta->>'subteam', '');
  new.display_name := nullif(meta->>'display_name', '');
  new.created_at   := now();
  return new;
end;
$$;

create trigger scores_stamp_identity
  before insert on games.scores
  for each row execute function games.stamp_score_identity();

alter table games.scores enable row level security;

-- The trigger has already forced user_id = auth.uid() by the time WITH CHECK
-- runs, so this is belt-and-braces.
create policy scores_insert_own on games.scores
  for insert to authenticated
  with check (user_id = auth.uid());

create policy scores_read_authed on games.scores
  for select to authenticated
  using (true);

grant usage on schema games to authenticated;
grant select, insert on games.scores to authenticated;
-- No update/delete for anyone but service role; nothing for anon.
revoke all on games.scores from anon;
revoke usage on schema games from anon;

-- =============================================================================
-- LEADERBOARD VIEWS (security_invoker: RLS on games.scores gates access)
-- =============================================================================

-- Per game: each player's best score ever. display_name/subteam taken from
-- the player's most recent run so renames/subteam changes win.
create view games.leaderboard_alltime
  with (security_invoker = true) as
select
  game_id,
  user_id,
  max(score) as best,
  (array_agg(display_name order by created_at desc))[1] as display_name,
  (array_agg(subteam      order by created_at desc))[1] as subteam
from games.scores
group by game_id, user_id;

-- Same, restricted to the current ISO week.
create view games.leaderboard_weekly
  with (security_invoker = true) as
select
  game_id,
  user_id,
  max(score) as best,
  (array_agg(display_name order by created_at desc))[1] as display_name,
  (array_agg(subteam      order by created_at desc))[1] as subteam
from games.scores
where created_at >= date_trunc('week', now())
group by game_id, user_id;

-- Per (subteam, game): sum of members' personal bests. The client sums the
-- per-game subtotals into the subteam grand total. Members with no scores
-- simply don't appear. Null subteam buckets as 'Unassigned'.
create view games.leaderboard_subteams
  with (security_invoker = true) as
with bests as (
  select
    game_id,
    user_id,
    max(score) as best,
    coalesce((array_agg(subteam order by created_at desc))[1], 'Unassigned') as subteam
  from games.scores
  group by game_id, user_id
)
select subteam, game_id, sum(best)::integer as subtotal
from bests
group by subteam, game_id;

grant select on games.leaderboard_alltime, games.leaderboard_weekly,
  games.leaderboard_subteams to authenticated;

-- =============================================================================
-- FIXTURE SPOT-CHECKS (run manually after applying; not part of the migration)
-- =============================================================================
-- insert into games.scores (user_id, game_id, score) values  -- as service role,
--   ('<uuid-a>','snake',10), ('<uuid-a>','snake',25),         -- trigger stamps
--   ('<uuid-b>','snake',15), ('<uuid-a>','2048',2048);        -- insert identity
-- select * from games.leaderboard_alltime where game_id = 'snake';
--   -- expect: a→25, b→15
-- select * from games.leaderboard_subteams;
--   -- expect: a+b's subteams with snake subtotals 25/15, plus 2048→2048
