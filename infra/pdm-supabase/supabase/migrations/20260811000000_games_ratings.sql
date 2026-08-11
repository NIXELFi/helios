-- 20260811000000_games_ratings.sql
--
-- Persistent per-player ratings for RATED games (currently just blackjack).
--
-- games.scores answers "what is your best run ever" — the right question for
-- Snake, the wrong one for a rating. A rating is a thing you are HOLDING: it
-- has to survive a bad night, and quitting three hands into a hot streak has
-- to be worth nothing. So rated games get their own table, keyed one row per
-- (player, game), and their leaderboard reads the CURRENT value rather than
-- max().
--
-- The client never sends a rating. It sends what it measured about the
-- session — how many hands, and the total advantage those hands were worth —
-- and this migration's RPC does the arithmetic. That makes the read-modify-
-- write atomic (two Helios windows can't clobber each other), forces the
-- length weighting to actually apply, and means a devtools console can't post
-- itself to the top of the board.
--
-- ⚠ The rating arithmetic below is deliberately duplicated from
--   apps/desktop/src/modules/games/games/blackjack/rating.ts, which is the
--   readable explanation of every constant and is pinned by tests against the
--   EV engine that produced them. If you change one, change both. The client
--   copy exists so the game can show a live projection; THIS copy is the one
--   that counts.

create table games.ratings (
  user_id      uuid not null references auth.users(id) on delete cascade,
  game_id      text not null check (game_id in ('blackjack')),
  rating       numeric(8,2) not null default 1000,
  hands_rated  integer not null default 0 check (hands_rated >= 0),
  sessions     integer not null default 0 check (sessions >= 0),
  peak         numeric(8,2) not null default 1000,
  -- Denormalised at write time from auth.users, same reasoning as games.scores:
  -- clients can't read other users' metadata, so the board needs it here.
  subteam      text,
  display_name text,
  updated_at   timestamptz not null default now(),
  primary key (user_id, game_id)
);

create index idx_games_ratings_board on games.ratings (game_id, rating desc);

-- One row per applied session: the audit trail, the idempotency key, and the
-- source for the weekly "who climbed most" board.
create table games.rating_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  game_id    text not null,
  nonce      text not null,
  hands      integer not null check (hands >= 0),
  advantage  numeric(10,4) not null,
  delta      numeric(8,2) not null,
  rating     numeric(8,2) not null,   -- resulting rating, for auditing
  created_at timestamptz not null default now(),
  unique (user_id, game_id, nonce)
);

create index idx_games_rating_sessions_week on games.rating_sessions (game_id, created_at);

-- =============================================================================
-- APPLY A SESSION
-- =============================================================================

create or replace function games.apply_rated_session(
  p_game_id   text,
  p_hands     integer,
  p_advantage numeric,
  p_nonce     text
)
-- OUT names deliberately avoid the column names on games.ratings: a RETURNS
-- TABLE column becomes a plpgsql variable, and an unqualified `rating` in any
-- statement below would then be ambiguous at runtime rather than at deploy.
returns table (new_rating numeric, applied_delta numeric, total_hands integer)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  -- Ladder constants — see rating.ts.
  c_start        constant numeric := 1000;
  c_floor        constant numeric := 100;
  c_tier         constant numeric := 400;
  c_tier_adv     constant numeric := 0.045879;  -- chart edge − reference edge
  c_full_hands   constant numeric := 25;        -- full session weight at/above this
  c_max_delta    constant numeric := 120;
  c_max_hand_adv constant numeric := 0.6;       -- MAX_HAND_ADVANTAGE
  c_max_hands    constant integer := 5000;      -- sanity bound on one session

  v_uid       uuid := auth.uid();
  v_meta      jsonb;
  v_cur       games.ratings%rowtype;
  v_prior     record;
  v_adv       numeric;
  v_k         numeric;
  v_weight    numeric;
  v_expected  numeric;
  v_delta     numeric;
  v_new       numeric;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_game_id is null or p_game_id <> 'blackjack' then
    raise exception 'not a rated game: %', p_game_id using errcode = '22023';
  end if;
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;
  if p_hands is null or p_hands < 0 or p_hands > c_max_hands then
    raise exception 'implausible hand count: %', p_hands using errcode = '22023';
  end if;

  -- Retry of a session already applied: hand back what it produced, unchanged.
  select rs.rating, rs.delta into v_prior
  from games.rating_sessions rs
  where rs.user_id = v_uid and rs.game_id = p_game_id and rs.nonce = p_nonce;
  if found then
    select coalesce(r.hands_rated, 0) into total_hands
    from games.ratings r where r.user_id = v_uid and r.game_id = p_game_id;
    new_rating    := v_prior.rating;
    applied_delta := v_prior.delta;
    return next;
    return;
  end if;

  -- No hands, nothing to rate — but still record the nonce so a retry stays a
  -- no-op rather than turning into a second empty session.
  -- Clamp the reported advantage to what the per-hand cap could possibly have
  -- produced. An honest client can never exceed this; a tampered one can't
  -- profit from trying.
  v_adv := greatest(-c_max_hand_adv * p_hands,
                    least(c_max_hand_adv * p_hands, coalesce(p_advantage, 0)));

  insert into games.ratings as r (user_id, game_id)
  values (v_uid, p_game_id)
  on conflict (user_id, game_id) do nothing;

  -- Lock the row for the read-modify-write so concurrent sessions serialise.
  select * into v_cur from games.ratings
  where user_id = v_uid and game_id = p_game_id
  for update;

  if p_hands = 0 then
    v_delta := 0;
    v_new := v_cur.rating;
  else
    v_k := case
             when v_cur.hands_rated < 200 then 64
             when v_cur.hands_rated < 1000 then 32
             else 16
           end;
    v_weight   := least(1.0, p_hands::numeric / c_full_hands);
    v_expected := c_tier_adv * (v_cur.rating - c_start) / c_tier;
    v_delta    := v_k * v_weight * ((v_adv / p_hands) - v_expected) / c_tier_adv;
    v_delta    := greatest(-c_max_delta, least(c_max_delta, v_delta));
    v_new      := greatest(c_floor, v_cur.rating + v_delta);
    -- Report the delta actually applied, so a floored session doesn't claim
    -- points it couldn't take.
    v_delta    := v_new - v_cur.rating;
  end if;

  select raw_user_meta_data into v_meta from auth.users where id = v_uid;

  update games.ratings r
     set rating       = v_new,
         hands_rated  = r.hands_rated + p_hands,
         sessions     = r.sessions + 1,
         peak         = greatest(r.peak, v_new),
         subteam      = nullif(v_meta->>'subteam', ''),
         display_name = nullif(v_meta->>'display_name', ''),
         updated_at   = now()
   where r.user_id = v_uid and r.game_id = p_game_id
   returning r.hands_rated into total_hands;

  insert into games.rating_sessions (user_id, game_id, nonce, hands, advantage, delta, rating)
  values (v_uid, p_game_id, p_nonce, p_hands, v_adv, v_delta, v_new);

  new_rating    := v_new;
  applied_delta := v_delta;
  return next;
end;
$$;

-- =============================================================================
-- RLS
-- =============================================================================

alter table games.ratings enable row level security;
alter table games.rating_sessions enable row level security;

-- Everyone signed in can read the board; nobody writes except through the RPC.
create policy ratings_read_authed on games.ratings
  for select to authenticated using (true);

-- Readable by anyone signed in, exactly like games.scores: these are game
-- results, not private data, and it lets the weekly board be a plain
-- security_invoker view instead of a definer one.
create policy rating_sessions_read_authed on games.rating_sessions
  for select to authenticated using (true);

grant select on games.ratings to authenticated;
grant select on games.rating_sessions to authenticated;
-- No direct writes: the RPC is the only way in.
revoke insert, update, delete on games.ratings from authenticated;
revoke insert, update, delete on games.rating_sessions from authenticated;
revoke all on games.ratings, games.rating_sessions from anon;
grant execute on function games.apply_rated_session(text, integer, numeric, text) to authenticated;
revoke execute on function games.apply_rated_session(text, integer, numeric, text) from anon;

-- =============================================================================
-- BOARDS
-- =============================================================================

-- All-time: the rating you are holding right now, not the best you ever saw.
create view games.leaderboard_ratings
  with (security_invoker = true) as
select
  game_id,
  user_id,
  round(rating)::integer as best,
  hands_rated,
  display_name,
  subteam
from games.ratings;

-- Weekly: how far you MOVED this week. A persistent rating has no meaningful
-- "best this week", but "who climbed hardest" is a real race — and unlike the
-- all-time board it resets, so a newcomer can win it.
create view games.leaderboard_ratings_weekly
  with (security_invoker = true) as
select
  s.game_id,
  s.user_id,
  round(sum(s.delta))::integer as best,
  (array_agg(r.display_name order by s.created_at desc))[1] as display_name,
  (array_agg(r.subteam      order by s.created_at desc))[1] as subteam
from games.rating_sessions s
join games.ratings r on r.user_id = s.user_id and r.game_id = s.game_id
where s.created_at >= date_trunc('week', now())
group by s.game_id, s.user_id;

-- Per (subteam, game) for the Grand Prix. NOT a plain sum of ratings: every
-- player starts at 1000, so summing would rank subteams by headcount. Points
-- come from how far members have climbed ABOVE the reference, counted only
-- once a rating means something, and floored at zero per player so a rookie
-- having a rough week can't drag their subteam down.
create view games.leaderboard_ratings_subteams
  with (security_invoker = true) as
select
  coalesce(subteam, 'Unassigned') as subteam,
  game_id,
  sum(greatest(0, round(rating)::integer - 1000))::integer as subtotal
from games.ratings
where hands_rated >= 25
group by coalesce(subteam, 'Unassigned'), game_id;

grant select on games.leaderboard_ratings, games.leaderboard_ratings_weekly,
  games.leaderboard_ratings_subteams to authenticated;

-- =============================================================================
-- BLACKJACK LEAVES games.scores
-- =============================================================================
-- Rated games no longer write scores rows, so drop 'blackjack' back out of the
-- constraint. The rows written by v5.4.0 are left in place as history: they
-- were session-end Elos from the old per-session formula and are not
-- comparable to a rating, but deleting a player's history to make a view
-- tidier is not a trade worth making. Nothing reads them any more — api.ts
-- routes blackjack to the ratings boards.
alter table games.scores
  drop constraint scores_game_id_check;

alter table games.scores
  add constraint scores_game_id_check
  check (game_id in ('snake','breakout','flappy','2048','blackjack'));

comment on constraint scores_game_id_check on games.scores is
  'blackjack is retained only so v5.4.0 history stays insertable-shaped; live blackjack writes go to games.ratings';
