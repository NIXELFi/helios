-- 20260818000000_games_rating_money_v3.sql
--
-- Blackjack rating v3: "skill money".
--
-- v2 rated pure per-unit decision quality and, by its own algebra, charged for
-- any raise above the table minimum at a neutral count — a chart-perfect
-- player pressing the 100-chip button lost rating every session while winning
-- chips. v3 re-denominates the whole thing in MONEY: a hand's advantage is the
-- expected chips (in table minimums) the player's decisions and stake earned
-- over the reference player from the same cards. Outcomes still never enter;
-- betting big on good play now climbs instead of bleeding, betting big on bad
-- play sinks proportionally. The ladder compresses money with a square root:
--
--   implied(m) = 1000 + 400 * sign(m) * sqrt(|m| / tier_advantage)
--
-- so mimic-the-dealer still sits at 1000, flawless flat-MINIMUM play still
-- sits at 1400, and real stakes on flawless play settle well above it.
--
-- Because the advantage SCALE changed (per-hand cap 0.6 → 2.0, typical values
-- ~20× larger for real bets), sessions measured by old clients are not
-- comparable to the new ladder. Two consequences below:
--   * the old 4-arg RPC becomes a harmless no-op (stale clients neither error
--     nor pollute; they simply stop rating until they update), and
--   * the ladder is reset to 1000 for everyone (Nick's call), with the
--     old-scale session history cleared so the weekly climb board doesn't mix
--     currencies.
--
-- ⚠ The rating arithmetic below is deliberately duplicated from
--   apps/desktop/src/modules/games/games/blackjack/rating.ts, which is the
--   readable explanation of every constant and is pinned by tests against the
--   EV engine that produced them. If you change one, change both. The client
--   copy exists so the game can show a live projection; THIS copy is the one
--   that counts.

-- =============================================================================
-- OLD RPC → NO-OP
-- =============================================================================
-- Kept callable so pre-v3 clients get a clean "nothing applied" instead of an
-- error toast at session end. Reads the current rating, writes nothing, and
-- deliberately does NOT record the nonce: recording it would burn table space
-- for sessions that were never applied. CREATE OR REPLACE preserves the
-- existing ACL (already revoked from PUBLIC, granted to authenticated).

create or replace function games.apply_rated_session(
  p_game_id   text,
  p_hands     integer,
  p_advantage numeric,
  p_nonce     text
)
returns table (new_rating numeric, applied_delta numeric, total_hands integer)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select r.rating, 0::numeric, coalesce(r.hands_rated, 0)
    into new_rating, applied_delta, total_hands
  from games.ratings r
  where r.user_id = v_uid and r.game_id = p_game_id;
  if not found then
    new_rating    := 1000;
    applied_delta := 0;
    total_hands   := 0;
  end if;
  return next;
end;
$$;

-- =============================================================================
-- APPLY A SESSION, v3
-- =============================================================================

create or replace function games.apply_rated_session_v3(
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
  c_max_hand_adv constant numeric := 2.0;       -- MAX_HAND_ADVANTAGE (money scale)
  c_max_hands    constant integer := 5000;      -- sanity bound on one session

  v_uid       uuid := auth.uid();
  v_meta      jsonb;
  v_cur       games.ratings%rowtype;
  v_prior     record;
  v_adv       numeric;
  v_avg       numeric;
  v_k         numeric;
  v_weight    numeric;
  v_implied   numeric;
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
    -- No hands, nothing to rate — but still record the nonce below so a retry
    -- stays a no-op rather than turning into a second empty session.
    v_delta := 0;
    v_new := v_cur.rating;
  else
    v_k := case
             when v_cur.hands_rated < 200 then 64
             when v_cur.hands_rated < 1000 then 32
             else 16
           end;
    v_weight  := least(1.0, p_hands::numeric / c_full_hands);
    v_avg     := v_adv / p_hands;
    -- The √ ladder map: where this session's money says the player belongs.
    v_implied := c_start + c_tier * sign(v_avg) * sqrt(abs(v_avg) / c_tier_adv);
    -- Move K/tier of the way there, weighted by session length.
    v_delta   := v_k * v_weight * (v_implied - v_cur.rating) / c_tier;
    v_delta   := greatest(-c_max_delta, least(c_max_delta, v_delta));
    v_new     := greatest(c_floor, v_cur.rating + v_delta);
    -- Report the delta actually applied, so a floored session doesn't claim
    -- points it couldn't take.
    v_delta   := v_new - v_cur.rating;
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

-- Postgres grants EXECUTE to PUBLIC on every new function, and anon inherits
-- it through PUBLIC — so revoking "from anon" alone is a no-op that merely
-- looks like hardening. Revoke PUBLIC first, then grant the one role back.
-- (Verified with has_function_privilege after the v5.4.1 incident.)
revoke execute on function games.apply_rated_session_v3(text, integer, numeric, text) from public;
grant  execute on function games.apply_rated_session_v3(text, integer, numeric, text) to authenticated;

-- =============================================================================
-- LADDER RESET
-- =============================================================================
-- Everyone back to 1000 (fresh K=64 convergence): old-scale ratings are not
-- comparable to money-scale ones, and Nick asked for a clean slate. The
-- session audit rows go with them — their deltas are in the old currency, and
-- leaving them would let the weekly climb board mix scales mid-week (and would
-- pin nonces from sessions the new ladder never saw).

delete from games.rating_sessions where game_id = 'blackjack';

update games.ratings
   set rating      = 1000,
       peak        = 1000,
       hands_rated = 0,
       sessions    = 0,
       updated_at  = now()
 where game_id = 'blackjack';
