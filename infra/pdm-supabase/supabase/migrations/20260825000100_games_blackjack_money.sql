-- 20260825000100_games_blackjack_money.sql
--
-- Blackjack moves onto the shared subteam budget.
--
-- Plinko settles in one shot: games.plinko_drop rolls the ball, pays it and
-- writes the ledger row inside a single transaction. A blackjack hand can't do
-- that — it is played over many seconds and several decisions — so it needs
-- TWO phases against the budget:
--
--   place_bet   chips leave the budget when the hand is dealt. They are on the
--               table from that moment, which is what the balance should show.
--   settle_bet  the payout goes back when the hand finishes.
--
-- That opens one hazard plinko never had: a hand can be ABANDONED between the
-- two, with the subteam's chips sitting in limbo. Refunding an abandoned bet
-- is not an option — the client knows the outcome before it settles, so
-- "refund on abandon" would pay a player to close the window on a losing hand.
-- An abandoned bet is therefore FORFEIT, exactly like walking away from a live
-- table mid-hand, and a partial unique index makes it impossible to open a
-- second hand while one is still out.
--
-- WHAT THE SERVER WILL AND WON'T BELIEVE
-- --------------------------------------
-- The shoe is still dealt client-side (see the v5.4 threat model: accidents,
-- not malice), so the server cannot know whether a hand was won. What it CAN
-- do for free is refuse a payout that no legal hand could produce: the only
-- amounts blackjack ever pays are nothing, the stake back, twice the stake, or
-- — on an unraised hand only — the 3:2 natural. Anything else is rejected. A
-- fabricated WIN is still possible; a fabricated 37x is not, and every bet
-- lands in a ledger the whole subteam can read.
--
-- The 5% cap is per BET, so doubling down debits a second, separately capped
-- amount: a doubled hand can have up to 10% of the budget on it. That is
-- deliberate and is the largest single exposure in the casino.
--
-- ⚠ Race discipline is identical to 20260825000000 and for the same reasons:
--   create-or-lock in one statement, cap checked AFTER the lock against the
--   value that statement returned, balance moved by a delta and never
--   read-modify-written, every entry point idempotent under a nonce.

-- One open hand per player per game. This is what makes "abandoned bets are
-- forfeit" enforceable rather than aspirational — without it a player could
-- leave losing hands open forever and keep dealing new ones.
create unique index idx_games_bets_one_open
  on games.bets (user_id, game_id)
  where status = 'open';

-- =============================================================================
-- PLACE
-- =============================================================================

create or replace function games.place_bet(
  p_game_id text,
  p_stake   bigint,
  p_nonce   text
)
returns table (
  bet_id      uuid,
  new_balance bigint,
  new_max_bet bigint,
  was_replay  boolean
)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid     uuid := auth.uid();
  v_subteam text;
  v_meta    jsonb;
  v_prior   record;
  v_balance bigint;
  v_cap     bigint;
  v_open    uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Plinko settles atomically in its own RPC and must never take this path.
  if p_game_id is null or p_game_id <> 'blackjack' then
    raise exception 'not a two-phase game: %', p_game_id using errcode = '22023';
  end if;
  if p_stake is null or p_stake <= 0 then
    raise exception 'stake must be a positive whole number of chips' using errcode = '22023';
  end if;
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  v_subteam := games.subteam_of(v_uid);

  -- Replay of a hand already dealt: hand back the same bet rather than
  -- debiting twice for one deal.
  select b.id into v_prior from games.bets b
  where b.user_id = v_uid and b.nonce = p_nonce;
  if found then
    bet_id := v_prior.id;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_subteam;
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
    return;
  end if;

  -- A hand still out has to be resolved before another is dealt. Reported
  -- explicitly so the cabinet can settle or forfeit it rather than guessing.
  select b.id into v_open from games.bets b
  where b.user_id = v_uid and b.game_id = p_game_id and b.status = 'open';
  if found then
    raise exception 'a hand is already open (%)', v_open using errcode = '55006';
  end if;

  begin
    insert into games.budgets as bg (subteam)
    values (v_subteam)
    on conflict (subteam) do update set updated_at = now()
    returning bg.balance into v_balance;

    v_cap := games.max_bet(v_balance);
    if p_stake > v_cap then
      raise exception 'one bet cannot exceed 5%% of the budget (max % chips, balance %)',
        v_cap, v_balance using errcode = '22023';
    end if;

    update games.budgets bg
       set balance    = bg.balance - p_stake,
           staked     = bg.staked + p_stake,
           bets       = bg.bets + 1,
           updated_at = now()
     where bg.subteam = v_subteam
    returning bg.balance into new_balance;

    select raw_user_meta_data into v_meta from auth.users where id = v_uid;

    insert into games.bets (
      user_id, subteam, game_id, nonce, stake, payout, status, detail,
      balance_after, display_name
    ) values (
      v_uid, v_subteam, p_game_id, p_nonce, p_stake, 0, 'open',
      jsonb_build_object('raised', false),
      new_balance, nullif(v_meta->>'display_name', '')
    )
    returning id into bet_id;

    new_max_bet := games.max_bet(new_balance);
    was_replay  := false;
    return next;

  exception when unique_violation then
    -- Either a concurrent call with this nonce, or a concurrent deal that won
    -- the one-open-hand index. Re-read: our nonce means it's a replay, anything
    -- else is the real conflict and must surface.
    select b.id into v_prior from games.bets b
    where b.user_id = v_uid and b.nonce = p_nonce;
    if not found then
      raise exception 'a hand is already open' using errcode = '55006';
    end if;
    bet_id := v_prior.id;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_subteam;
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
  end;
end;
$$;

-- =============================================================================
-- RAISE (double down)
-- =============================================================================
-- Debits a SECOND amount equal to the original stake, capped on its own. The
-- raise nonce lives in the bet's detail rather than the nonce column, which
-- belongs to the deal.

create or replace function games.raise_bet(p_bet_id uuid, p_nonce text)
returns table (
  new_stake   bigint,
  new_balance bigint,
  new_max_bet bigint,
  was_replay  boolean
)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid     uuid := auth.uid();
  v_bet     games.bets%rowtype;
  v_balance bigint;
  v_cap     bigint;
  v_extra   bigint;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  -- Lock the BET first, then the budget: every function in this pair takes
  -- them in that order, so no cycle can form.
  select * into v_bet from games.bets
  where id = p_bet_id and user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;
  if v_bet.status <> 'open' then
    raise exception 'that hand is already settled' using errcode = '22023';
  end if;

  if v_bet.detail->>'raise_nonce' = p_nonce then
    new_stake := v_bet.stake;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_bet.subteam;
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
    return;
  end if;
  if (v_bet.detail->>'raised')::boolean then
    raise exception 'that hand has already been doubled' using errcode = '22023';
  end if;

  v_extra := v_bet.stake;

  select bg.balance into v_balance from games.budgets bg
  where bg.subteam = v_bet.subteam
  for update;

  v_cap := games.max_bet(v_balance);
  if v_extra > v_cap then
    raise exception 'doubling would exceed 5%% of the budget (max % chips, balance %)',
      v_cap, v_balance using errcode = '22023';
  end if;

  update games.budgets bg
     set balance    = bg.balance - v_extra,
         staked     = bg.staked + v_extra,
         updated_at = now()
   where bg.subteam = v_bet.subteam
  returning bg.balance into new_balance;

  update games.bets b
     set stake         = b.stake + v_extra,
         balance_after = new_balance,
         detail        = b.detail
                         || jsonb_build_object('raised', true, 'raise_nonce', p_nonce)
   where b.id = p_bet_id
  returning b.stake into new_stake;

  new_max_bet := games.max_bet(new_balance);
  was_replay  := false;
  return next;
end;
$$;

-- =============================================================================
-- SETTLE
-- =============================================================================

create or replace function games.settle_bet(
  p_bet_id  uuid,
  p_payout  bigint,
  p_outcome text,
  p_nonce   text
)
returns table (
  settled_payout bigint,
  settled_net    bigint,
  new_balance    bigint,
  new_max_bet    bigint,
  was_replay     boolean
)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid   uuid := auth.uid();
  v_bet   games.bets%rowtype;
  v_legal bigint[];
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_payout is null or p_payout < 0 then
    raise exception 'payout cannot be negative' using errcode = '22023';
  end if;

  select * into v_bet from games.bets
  where id = p_bet_id and user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;

  -- Already settled: hand back what it produced. Covers the retry AND the
  -- concurrent double-settle, since the row lock serialises them.
  if v_bet.status <> 'open' then
    settled_payout := v_bet.payout;
    settled_net    := v_bet.net;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_bet.subteam;
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
    return;
  end if;

  -- The only amounts a blackjack hand can pay: nothing, the stake back (push),
  -- twice the stake (win), or the 3:2 natural — the last only on a hand that
  -- was never doubled, since a natural settles before doubling is offered.
  -- This can't tell a real win from a claimed one, but it does refuse any
  -- number no legal hand could ever produce.
  v_legal := array[0::bigint, v_bet.stake, v_bet.stake * 2];
  if not (v_bet.detail->>'raised')::boolean then
    v_legal := v_legal || (v_bet.stake + floor(v_bet.stake * 1.5)::bigint);
  end if;
  if not (p_payout = any(v_legal)) then
    raise exception 'payout % is not one of the legal results for a % chip hand (%)',
      p_payout, v_bet.stake, array_to_string(v_legal, ', ') using errcode = '22023';
  end if;

  update games.budgets bg
     set balance    = bg.balance + p_payout,
         returned   = bg.returned + p_payout,
         updated_at = now()
   where bg.subteam = v_bet.subteam
  returning bg.balance into new_balance;

  update games.bets b
     set payout        = p_payout,
         status        = 'settled',
         settled_at    = now(),
         balance_after = new_balance,
         detail        = b.detail || jsonb_build_object(
                           'outcome', coalesce(p_outcome, 'unknown'),
                           'settle_nonce', p_nonce)
   where b.id = p_bet_id
  returning b.payout, b.net into settled_payout, settled_net;

  new_max_bet := games.max_bet(new_balance);
  was_replay  := false;
  return next;
end;
$$;

-- =============================================================================
-- FORFEIT
-- =============================================================================
-- Closes an abandoned hand at nothing. Called by the cabinet when it finds a
-- hand still open from a previous session (a crash, a closed window, a machine
-- that went to sleep mid-deal).
--
-- It deliberately settles rather than refunds. The client knows the outcome
-- before it settles, so refunding an abandoned hand would pay players to close
-- the window on losers. Recorded as a normal settled row so the chips show up
-- in the ledger where they went, flagged so the UI can say what happened.

create or replace function games.forfeit_open_bet(p_game_id text)
returns table (
  forfeited_id    uuid,
  forfeited_stake bigint
)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_bet games.bets%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_bet from games.bets
  where user_id = v_uid and game_id = p_game_id and status = 'open'
  for update;
  if not found then
    return; -- nothing open: not an error, just nothing to do
  end if;
  update games.bets b
     set status     = 'settled',
         payout     = 0,
         settled_at = now(),
         detail     = b.detail || jsonb_build_object('outcome', 'forfeit', 'forfeited', true)
   where b.id = v_bet.id;
  forfeited_id    := v_bet.id;
  forfeited_stake := v_bet.stake;
  return next;
end;
$$;

-- =============================================================================
-- GRANTS
-- =============================================================================
-- PUBLIC first, then the one role back — anon inherits EXECUTE through PUBLIC,
-- so revoking "from anon" alone only looks like hardening.

revoke execute on function games.place_bet(text, bigint, text) from public;
grant  execute on function games.place_bet(text, bigint, text) to authenticated;
revoke execute on function games.raise_bet(uuid, text) from public;
grant  execute on function games.raise_bet(uuid, text) to authenticated;
revoke execute on function games.settle_bet(uuid, bigint, text, text) from public;
grant  execute on function games.settle_bet(uuid, bigint, text, text) to authenticated;
revoke execute on function games.forfeit_open_bet(text) from public;
grant  execute on function games.forfeit_open_bet(text) to authenticated;

-- Blackjack keeps writing games.ratings as well: the rating is now a personal
-- number rather than the casino scoreboard, but it is still earned per hand
-- and still submitted per session by apply_rated_session_v3. Nothing about
-- that changes here.
comment on function games.place_bet(text, bigint, text) is
  'Two-phase bet for blackjack: debits the subteam budget when a hand is dealt. Settle with settle_bet, or forfeit_open_bet if the hand was abandoned.';
