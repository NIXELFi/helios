-- 20260829000100_games_blackjack_server_shoe.sql
--
-- Blackjack moves onto a SERVER-DEALT shoe, and the games schema gets a ban
-- list. Together these close the 2026-08-28 incident: a player fabricated
-- arcade scores by hand-rolled REST inserts (closed by 20260829000000) and
-- then fabricated blackjack WINS through games.settle_bet, which by design
-- could refuse an illegal payout amount but could not tell a real win from a
-- claimed one — the shoe lived in the client.
--
-- WHAT CHANGES
-- ------------
--  * The server deals. A per-player 4-deck shoe and the live hand (hole card
--    included) live in tables no client role can read; the client is handed
--    exactly what a player at a table can see, and the dealer's hole card only
--    comes back once the hand is over. House rules are unchanged: dealer
--    stands on all 17s, blackjack pays 3:2 rounded down, double on any first
--    two cards, no split / insurance / surrender.
--  * Settlement is computed here, in the same transaction that draws the
--    cards. There is no payout parameter anywhere in the new flow, so there is
--    nothing to lie about.
--  * The legacy two-phase surface (place_bet / raise_bet / settle_bet) is
--    REVOKED from clients. The bodies stay for the audit trail, and settle_bet
--    additionally refuses any server-dealt hand outright, so re-granting it by
--    accident cannot reopen the hole.
--  * games.banned_players: players on it are refused by every game entry point
--    — score inserts, plinko, blackjack, the budget RPC and forfeit — with the
--    same error whichever door they knock on.
--
-- Race discipline is identical to 20260825000000 and for the same reasons:
-- create-or-lock in one statement, cap checked AFTER the lock, balances moved
-- by delta only, every entry point idempotent (deal under the (user_id,nonce)
-- unique index; hit/stand/double under a per-hand action-nonce map that
-- replays the stored response). Lock order is bet row -> hand -> shoe ->
-- budget everywhere a bet row exists, and shoe -> budget in bj_deal, which
-- inserts the bet row last; the budget row is always taken last, so no cycle
-- can form.

-- =============================================================================
-- BAN LIST
-- =============================================================================
-- Managed only with the service role / SQL: no policies, no grants, so clients
-- can neither read it nor find out who is on it.

create table games.banned_players (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  reason    text,
  banned_at timestamptz not null default now()
);

alter table games.banned_players enable row level security;

create or replace function games.assert_playable(p_uid uuid)
returns void
language plpgsql
stable
security definer
set search_path = games
as $$
begin
  if exists (select 1 from games.banned_players b where b.user_id = p_uid) then
    raise exception 'games access is revoked for this account' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function games.assert_playable(uuid) from public;

-- Ban rows are DATA, not schema: they are inserted out-of-band with the
-- service role (same posture as games.set_budget), never seeded here — a
-- migration lives forever in a public repo, and a ban row names a person.
-- The ban is also deliberately a WRITE gate only: existing ledger/board rows
-- stay readable for audit honesty (fabricated rows are removed out-of-band
-- as part of whatever incident led to the ban).

-- =============================================================================
-- PRIVATE TABLE STATE
-- =============================================================================
-- games.bets stays the public ledger. Everything the player must NOT see —
-- the hole card before the reveal, the order of the cards still in the shoe —
-- lives here, with RLS on and not a single grant: only the SECURITY DEFINER
-- RPCs below (owner: postgres) can touch these rows.

create table games.bj_shoes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  cards      jsonb not null,       -- [{rank,suit}, ...]; draw = pop from the END
  updated_at timestamptz not null default now()
);

create table games.bj_hands (
  bet_id     uuid primary key references games.bets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  player     jsonb not null,
  dealer     jsonb not null,       -- [upcard, hole]; hole leaves this table only at settle
  phase      text not null default 'player' check (phase in ('player','settled')),
  -- Response snapshot per action nonce, so a retried hit can NEVER draw a
  -- second card. Kept after settle (phase 'settled') so a settle-crossing
  -- retry still replays; cleared at the player's next deal.
  actions    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_games_bj_hands_user on games.bj_hands (user_id, phase);

alter table games.bj_shoes enable row level security;
alter table games.bj_hands enable row level security;

-- =============================================================================
-- CARD HELPERS
-- =============================================================================

-- A fresh shuffled 4-deck shoe. Fisher-Yates over pgcrypto randomness, two
-- bytes per swap: 65536 mod (i+1) leaves a worst-case bias of 208/65536
-- (~0.3%) toward low indices, which is accepted for a toy casino.
create or replace function games.bj_new_shoe()
returns jsonb
language plpgsql
volatile
security definer
set search_path = games, extensions
as $$
declare
  ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  suits text[] := array['S','H','D','C'];
  idx   int[] := array(select generate_series(0, 207));
  b     bytea;
  j     int;
  tmp   int;
  shoe  jsonb;
begin
  for i in reverse 207..1 loop
    b := gen_random_bytes(2);
    j := ((get_byte(b, 0) << 8) | get_byte(b, 1)) % (i + 1);
    tmp := idx[i + 1]; idx[i + 1] := idx[j + 1]; idx[j + 1] := tmp;
  end loop;
  select jsonb_agg(
           jsonb_build_object(
             'rank', ranks[((u % 52) % 13) + 1],
             'suit', suits[((u % 52) / 13) + 1])
           order by ord)
    into shoe
  from unnest(idx) with ordinality as t(u, ord);
  return shoe;
end;
$$;

-- Best blackjack total. At most one ace can count as 11 (two would be 22).
create or replace function games.bj_hand_value(p_cards jsonb, out total integer, out soft boolean)
language plpgsql
immutable
set search_path = ''
as $$
declare
  c    jsonb;
  r    text;
  aces integer := 0;
begin
  total := 0;
  soft  := false;
  for c in select jsonb_array_elements(p_cards) loop
    r := c->>'rank';
    if r = 'A' then
      aces  := aces + 1;
      total := total + 1;
    elsif r in ('K','Q','J','10') then
      total := total + 10;
    else
      total := total + r::integer;
    end if;
  end loop;
  if aces > 0 and total + 10 <= 21 then
    total := total + 10;
    soft  := true;
  end if;
end;
$$;

-- Dealer draws to 17+ (stands on ALL 17s, soft included). The caller holds the
-- shoe row lock and writes o_shoe back. An exhausted shoe mid-hand is
-- unreachable through bj_deal's reshuffle-below-26 guard, but a fresh shoe is
-- spliced in anyway rather than failing a hand that has money on it.
create or replace function games.bj_run_dealer(
  p_dealer jsonb, p_shoe jsonb,
  out o_dealer jsonb, out o_shoe jsonb, out o_reshuffled boolean
)
language plpgsql
volatile
security definer
set search_path = games
as $$
declare
  v_total integer;
begin
  o_dealer     := p_dealer;
  o_shoe       := p_shoe;
  o_reshuffled := false;
  loop
    select total into v_total from games.bj_hand_value(o_dealer);
    exit when v_total >= 17;
    if jsonb_array_length(o_shoe) = 0 then
      o_shoe       := games.bj_new_shoe();
      o_reshuffled := true;
    end if;
    o_dealer := o_dealer || jsonb_build_array(o_shoe -> -1);
    o_shoe   := o_shoe - (-1);
  end loop;
end;
$$;

-- Close a hand: credit the budget (delta, under its row lock), settle the bets
-- row with the full final hands in the public detail, and mark the private
-- hand row settled (kept for action-nonce replays until the next deal).
-- Returns the new budget balance.
create or replace function games.bj_finish(
  p_bet_id uuid, p_subteam text,
  p_player jsonb, p_dealer jsonb,
  p_outcome text, p_payout bigint
)
returns bigint
language plpgsql
security definer
set search_path = games, public
as $$
declare
  v_balance bigint;
begin
  update games.budgets bg
     set balance    = bg.balance + p_payout,
         returned   = bg.returned + p_payout,
         updated_at = now()
   where bg.subteam = p_subteam
  returning bg.balance into v_balance;

  update games.bets b
     set payout        = p_payout,
         status        = 'settled',
         settled_at    = now(),
         balance_after = v_balance,
         detail        = b.detail || jsonb_build_object(
                           'outcome', p_outcome,
                           'player',  p_player,
                           'dealer',  p_dealer)
   where b.id = p_bet_id;

  update games.bj_hands h
     set player = p_player, dealer = p_dealer, phase = 'settled', updated_at = now()
   where h.bet_id = p_bet_id;

  return v_balance;
end;
$$;

-- The uniform response row, reconstructed from whatever the tables currently
-- say. Used by every replay path, so a retry always answers with the same
-- shape as the call it is retrying. Balance is reported LIVE (teammates move
-- it), same reasoning as plinko_drop's replay.
create or replace function games.bj_state_of(p_bet_id uuid)
returns table (
  bj_bet_id uuid, bj_state text, bj_player jsonb, bj_dealer jsonb,
  bj_stake bigint, bj_outcome text, bj_payout bigint,
  new_balance bigint, new_max_bet bigint,
  bj_cards_left integer, bj_reshuffled boolean, was_replay boolean
)
language plpgsql
security definer
set search_path = games, public
as $$
declare
  v_bet  games.bets%rowtype;
  v_hand games.bj_hands%rowtype;
begin
  select * into v_bet from games.bets b where b.id = p_bet_id;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;
  select * into v_hand from games.bj_hands h where h.bet_id = p_bet_id;

  bj_bet_id := v_bet.id;
  bj_stake  := v_bet.stake;
  bj_player := coalesce(v_hand.player, v_bet.detail->'player');
  if v_bet.status = 'open' then
    bj_state   := 'player';
    bj_dealer  := jsonb_build_array(v_hand.dealer -> 0);
    bj_outcome := null;
    bj_payout  := null;
  else
    bj_state   := 'settled';
    bj_dealer  := coalesce(v_hand.dealer, v_bet.detail->'dealer');
    bj_outcome := v_bet.detail->>'outcome';
    bj_payout  := v_bet.payout;
  end if;

  select coalesce(jsonb_array_length(s.cards), 0) into bj_cards_left
  from games.bj_shoes s where s.user_id = v_bet.user_id;
  bj_cards_left := coalesce(bj_cards_left, 0);

  select bg.balance into new_balance from games.budgets bg where bg.subteam = v_bet.subteam;
  new_max_bet   := games.max_bet(new_balance);
  bj_reshuffled := false;
  was_replay    := true;
  return next;
end;
$$;

revoke execute on function games.bj_new_shoe() from public;
revoke execute on function games.bj_hand_value(jsonb) from public;
revoke execute on function games.bj_run_dealer(jsonb, jsonb) from public;
revoke execute on function games.bj_finish(uuid, text, jsonb, jsonb, text, bigint) from public;
revoke execute on function games.bj_state_of(uuid) from public;

-- =============================================================================
-- DEAL
-- =============================================================================

create or replace function games.bj_deal(p_stake bigint, p_nonce text)
returns table (
  bj_bet_id uuid, bj_state text, bj_player jsonb, bj_dealer jsonb,
  bj_stake bigint, bj_outcome text, bj_payout bigint,
  new_balance bigint, new_max_bet bigint,
  bj_cards_left integer, bj_reshuffled boolean, was_replay boolean
)
language plpgsql
security definer
set search_path = games, public, auth, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_subteam text;
  v_meta    jsonb;
  v_prior   games.bets%rowtype;
  v_open    uuid;
  v_balance bigint;
  v_cap     bigint;
  v_shoe    jsonb;
  v_resh    boolean := false;
  v_player  jsonb;
  v_dealer  jsonb;
  v_pt      integer;
  v_dt      integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform games.assert_playable(v_uid);
  if p_stake is null or p_stake <= 0 then
    raise exception 'stake must be a positive whole number of chips' using errcode = '22023';
  end if;
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  v_subteam := games.subteam_of(v_uid);

  -- Replay of a deal already made: hand back the table as it stands.
  select * into v_prior from games.bets b
  where b.user_id = v_uid and b.nonce = p_nonce;
  if found then
    return query select * from games.bj_state_of(v_prior.id);
    return;
  end if;

  -- A hand still out has to be resolved first. Reported explicitly so the
  -- cabinet can settle or forfeit it rather than guessing.
  select b.id into v_open from games.bets b
  where b.user_id = v_uid and b.game_id = 'blackjack' and b.status = 'open';
  if found then
    raise exception 'a hand is already open (%)', v_open using errcode = '55006';
  end if;

  -- The previous hand's replay snapshots have served their purpose.
  delete from games.bj_hands h where h.user_id = v_uid and h.phase = 'settled';

  begin
    -- SHOE: create-or-lock in one statement (same load-bearing ON CONFLICT DO
    -- UPDATE as the budgets row — DO NOTHING can return no row to lock).
    insert into games.bj_shoes as s (user_id, cards)
    values (v_uid, games.bj_new_shoe())
    on conflict (user_id) do update set updated_at = now()
    returning s.cards into v_shoe;
    -- Reshuffle between hands once the shoe drops below 26 cards —
    -- comfortably more than the worst-case single hand can consume.
    if jsonb_array_length(v_shoe) < 26 then
      v_shoe := games.bj_new_shoe();
      v_resh := true;
    end if;

    -- BUDGET: create-or-lock; cap checked AFTER the lock, against the balance
    -- that statement returned (the TOCTOU race from 20260825000000).
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

    -- Deal order matches a real table (and the old client): player, player,
    -- dealer up, dealer hole.
    v_player := jsonb_build_array(v_shoe -> -1); v_shoe := v_shoe - (-1);
    v_player := v_player || jsonb_build_array(v_shoe -> -1); v_shoe := v_shoe - (-1);
    v_dealer := jsonb_build_array(v_shoe -> -1); v_shoe := v_shoe - (-1);
    v_dealer := v_dealer || jsonb_build_array(v_shoe -> -1); v_shoe := v_shoe - (-1);

    update games.bj_shoes s
       set cards = v_shoe, updated_at = now()
     where s.user_id = v_uid;

    select raw_user_meta_data into v_meta from auth.users where id = v_uid;

    insert into games.bets (
      user_id, subteam, game_id, nonce, stake, payout, status, detail,
      balance_after, display_name
    ) values (
      v_uid, v_subteam, 'blackjack', p_nonce, p_stake, 0, 'open',
      jsonb_build_object('raised', false, 'server_shoe', true),
      new_balance, nullif(v_meta->>'display_name', '')
    )
    returning id into bj_bet_id;

    insert into games.bj_hands (bet_id, user_id, player, dealer)
    values (bj_bet_id, v_uid, v_player, v_dealer);

    select total into v_pt from games.bj_hand_value(v_player);
    select total into v_dt from games.bj_hand_value(v_dealer);

    bj_player := v_player;
    bj_stake  := p_stake;

    if v_pt = 21 or v_dt = 21 then
      -- Naturals settle on the spot (peek rule): push, 3:2 rounded down, or a
      -- loss the player never got a decision in.
      if v_pt = 21 and v_dt = 21 then
        bj_outcome := 'push';
        bj_payout  := p_stake;
      elsif v_pt = 21 then
        bj_outcome := 'blackjack';
        -- stake + floor(stake * 1.5): integer division floors, matching both
        -- the client's settle() and the legacy legal-payout set.
        bj_payout  := p_stake + (p_stake * 3) / 2;
      else
        bj_outcome := 'lose';
        bj_payout  := 0;
      end if;
      new_balance := games.bj_finish(bj_bet_id, v_subteam, v_player, v_dealer, bj_outcome, bj_payout);
      bj_state  := 'settled';
      bj_dealer := v_dealer;
    else
      bj_state   := 'player';
      bj_dealer  := jsonb_build_array(v_dealer -> 0);
      bj_outcome := null;
      bj_payout  := null;
    end if;

    new_max_bet   := games.max_bet(new_balance);
    bj_cards_left := jsonb_array_length(v_shoe);
    bj_reshuffled := v_resh;
    was_replay    := false;
    return next;

  exception when unique_violation then
    -- A concurrent deal with this nonce, or a concurrent deal that won the
    -- one-open-hand index. Our subtransaction (debit included) has rolled
    -- back; re-read and arbitrate, same as place_bet did.
    select * into v_prior from games.bets b
    where b.user_id = v_uid and b.nonce = p_nonce;
    if not found then
      raise exception 'a hand is already open' using errcode = '55006';
    end if;
    return query select * from games.bj_state_of(v_prior.id);
  end;
end;
$$;

-- =============================================================================
-- HIT / STAND / DOUBLE share a preamble: lock the bet row, then the hand row,
-- replay a known action nonce verbatim, refuse a settled hand. Each snapshots
-- its response under the nonce before returning.
-- =============================================================================

create or replace function games.bj_hit(p_bet_id uuid, p_nonce text)
returns table (
  bj_bet_id uuid, bj_state text, bj_player jsonb, bj_dealer jsonb,
  bj_stake bigint, bj_outcome text, bj_payout bigint,
  new_balance bigint, new_max_bet bigint,
  bj_cards_left integer, bj_reshuffled boolean, was_replay boolean
)
language plpgsql
security definer
set search_path = games, public, auth, extensions
as $$
declare
  v_uid    uuid := auth.uid();
  v_bet    games.bets%rowtype;
  v_hand   games.bj_hands%rowtype;
  v_shoe   jsonb;
  v_resh   boolean := false;
  v_player jsonb;
  v_pt     integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform games.assert_playable(v_uid);
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  select * into v_bet from games.bets b
  where b.id = p_bet_id and b.user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;
  select * into v_hand from games.bj_hands h
  where h.bet_id = p_bet_id
  for update;
  if not found then
    raise exception 'not a server-dealt hand' using errcode = '22023';
  end if;

  if v_hand.actions ? p_nonce then
    return query select * from games.bj_state_of(p_bet_id);
    return;
  end if;
  if v_bet.status <> 'open' then
    raise exception 'that hand is already settled' using errcode = '22023';
  end if;

  select s.cards into v_shoe from games.bj_shoes s
  where s.user_id = v_uid
  for update;
  if v_shoe is null or jsonb_array_length(v_shoe) = 0 then
    v_shoe := games.bj_new_shoe();
    v_resh := true;
  end if;

  v_player := v_hand.player || jsonb_build_array(v_shoe -> -1);
  v_shoe   := v_shoe - (-1);
  -- Upsert, not update: a missing shoe row (unreachable today, but only
  -- incidentally) must not silently drop the write and desync the count.
  insert into games.bj_shoes as s (user_id, cards) values (v_uid, v_shoe)
  on conflict (user_id) do update set cards = excluded.cards, updated_at = now();

  select total into v_pt from games.bj_hand_value(v_player);

  bj_bet_id := v_bet.id;
  bj_player := v_player;
  bj_stake  := v_bet.stake;

  if v_pt > 21 then
    bj_outcome  := 'lose';
    bj_payout   := 0;
    new_balance := games.bj_finish(v_bet.id, v_bet.subteam, v_player, v_hand.dealer, bj_outcome, bj_payout);
    bj_state    := 'settled';
    bj_dealer   := v_hand.dealer;   -- bust just shows the hole
  else
    update games.bj_hands h set player = v_player, updated_at = now()
    where h.bet_id = v_bet.id;
    bj_state   := 'player';
    bj_dealer  := jsonb_build_array(v_hand.dealer -> 0);
    bj_outcome := null;
    bj_payout  := null;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_bet.subteam;
  end if;

  new_max_bet   := games.max_bet(new_balance);
  bj_cards_left := jsonb_array_length(v_shoe);
  bj_reshuffled := v_resh;
  was_replay    := false;

  update games.bj_hands h
     set actions = h.actions || jsonb_build_object(p_nonce, true), updated_at = now()
   where h.bet_id = v_bet.id;
  return next;
end;
$$;

create or replace function games.bj_stand(p_bet_id uuid, p_nonce text)
returns table (
  bj_bet_id uuid, bj_state text, bj_player jsonb, bj_dealer jsonb,
  bj_stake bigint, bj_outcome text, bj_payout bigint,
  new_balance bigint, new_max_bet bigint,
  bj_cards_left integer, bj_reshuffled boolean, was_replay boolean
)
language plpgsql
security definer
set search_path = games, public, auth, extensions
as $$
declare
  v_uid    uuid := auth.uid();
  v_bet    games.bets%rowtype;
  v_hand   games.bj_hands%rowtype;
  v_shoe   jsonb;
  v_run    record;
  v_pt     integer;
  v_dt     integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform games.assert_playable(v_uid);
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  select * into v_bet from games.bets b
  where b.id = p_bet_id and b.user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;
  select * into v_hand from games.bj_hands h
  where h.bet_id = p_bet_id
  for update;
  if not found then
    raise exception 'not a server-dealt hand' using errcode = '22023';
  end if;

  if v_hand.actions ? p_nonce then
    return query select * from games.bj_state_of(p_bet_id);
    return;
  end if;
  if v_bet.status <> 'open' then
    raise exception 'that hand is already settled' using errcode = '22023';
  end if;

  select s.cards into v_shoe from games.bj_shoes s
  where s.user_id = v_uid
  for update;
  v_shoe := coalesce(v_shoe, games.bj_new_shoe());

  select * into v_run from games.bj_run_dealer(v_hand.dealer, v_shoe);
  insert into games.bj_shoes as s (user_id, cards) values (v_uid, v_run.o_shoe)
  on conflict (user_id) do update set cards = excluded.cards, updated_at = now();

  select total into v_pt from games.bj_hand_value(v_hand.player);
  select total into v_dt from games.bj_hand_value(v_run.o_dealer);

  bj_bet_id := v_bet.id;
  bj_player := v_hand.player;
  bj_stake  := v_bet.stake;
  bj_dealer := v_run.o_dealer;
  bj_state  := 'settled';

  if v_dt > 21 or v_pt > v_dt then
    bj_outcome := 'win';
    bj_payout  := v_bet.stake * 2;
  elsif v_pt < v_dt then
    bj_outcome := 'lose';
    bj_payout  := 0;
  else
    bj_outcome := 'push';
    bj_payout  := v_bet.stake;
  end if;

  new_balance   := games.bj_finish(v_bet.id, v_bet.subteam, v_hand.player, v_run.o_dealer, bj_outcome, bj_payout);
  new_max_bet   := games.max_bet(new_balance);
  bj_cards_left := jsonb_array_length(v_run.o_shoe);
  bj_reshuffled := v_run.o_reshuffled;
  was_replay    := false;

  update games.bj_hands h
     set actions = h.actions || jsonb_build_object(p_nonce, true), updated_at = now()
   where h.bet_id = v_bet.id;
  return next;
end;
$$;

create or replace function games.bj_double(p_bet_id uuid, p_nonce text)
returns table (
  bj_bet_id uuid, bj_state text, bj_player jsonb, bj_dealer jsonb,
  bj_stake bigint, bj_outcome text, bj_payout bigint,
  new_balance bigint, new_max_bet bigint,
  bj_cards_left integer, bj_reshuffled boolean, was_replay boolean
)
language plpgsql
security definer
set search_path = games, public, auth, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_bet     games.bets%rowtype;
  v_hand    games.bj_hands%rowtype;
  v_shoe    jsonb;
  v_resh    boolean := false;
  v_run     record;
  v_balance bigint;
  v_cap     bigint;
  v_extra   bigint;
  v_stake   bigint;
  v_player  jsonb;
  v_pt      integer;
  v_dt      integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform games.assert_playable(v_uid);
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  select * into v_bet from games.bets b
  where b.id = p_bet_id and b.user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;
  select * into v_hand from games.bj_hands h
  where h.bet_id = p_bet_id
  for update;
  if not found then
    raise exception 'not a server-dealt hand' using errcode = '22023';
  end if;

  if v_hand.actions ? p_nonce then
    return query select * from games.bj_state_of(p_bet_id);
    return;
  end if;
  if v_bet.status <> 'open' then
    raise exception 'that hand is already settled' using errcode = '22023';
  end if;
  if jsonb_array_length(v_hand.player) <> 2 then
    raise exception 'doubling is only allowed on the first two cards' using errcode = '22023';
  end if;
  if (v_bet.detail->>'raised')::boolean then
    raise exception 'that hand has already been doubled' using errcode = '22023';
  end if;

  -- Shoe BEFORE budget, keeping the bet -> hand -> shoe -> budget order every
  -- sibling uses — the budget row is always the last lock taken.
  select s.cards into v_shoe from games.bj_shoes s
  where s.user_id = v_uid
  for update;
  if v_shoe is null or jsonb_array_length(v_shoe) = 0 then
    v_shoe := games.bj_new_shoe();
    v_resh := true;
  end if;

  -- The double is a SECOND debit of the same size, capped on its own — a
  -- doubled hand can carry up to 10% of the budget, exactly as before.
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
   where bg.subteam = v_bet.subteam;

  v_stake := v_bet.stake + v_extra;
  update games.bets b
     set stake  = v_stake,
         detail = b.detail || jsonb_build_object('raised', true)
   where b.id = v_bet.id;

  -- One card, face up, then the dealer plays it out (unless it busts).
  v_player := v_hand.player || jsonb_build_array(v_shoe -> -1);
  v_shoe   := v_shoe - (-1);

  select total into v_pt from games.bj_hand_value(v_player);

  bj_bet_id := v_bet.id;
  bj_player := v_player;
  bj_stake  := v_stake;
  bj_state  := 'settled';

  if v_pt > 21 then
    insert into games.bj_shoes as s (user_id, cards) values (v_uid, v_shoe)
    on conflict (user_id) do update set cards = excluded.cards, updated_at = now();
    bj_outcome    := 'lose';
    bj_payout     := 0;
    bj_dealer     := v_hand.dealer;
    bj_reshuffled := v_resh;
    bj_cards_left := jsonb_array_length(v_shoe);
  else
    select * into v_run from games.bj_run_dealer(v_hand.dealer, v_shoe);
    insert into games.bj_shoes as s (user_id, cards) values (v_uid, v_run.o_shoe)
    on conflict (user_id) do update set cards = excluded.cards, updated_at = now();
    select total into v_dt from games.bj_hand_value(v_run.o_dealer);
    if v_dt > 21 or v_pt > v_dt then
      bj_outcome := 'win';
      bj_payout  := v_stake * 2;
    elsif v_pt < v_dt then
      bj_outcome := 'lose';
      bj_payout  := 0;
    else
      bj_outcome := 'push';
      bj_payout  := v_stake;
    end if;
    bj_dealer     := v_run.o_dealer;
    bj_reshuffled := v_resh or v_run.o_reshuffled;
    bj_cards_left := jsonb_array_length(v_run.o_shoe);
  end if;

  new_balance := games.bj_finish(v_bet.id, v_bet.subteam, v_player, bj_dealer, bj_outcome, bj_payout);
  new_max_bet := games.max_bet(new_balance);
  was_replay  := false;

  update games.bj_hands h
     set actions = h.actions || jsonb_build_object(p_nonce, true), updated_at = now()
   where h.bet_id = v_bet.id;
  return next;
end;
$$;

revoke execute on function games.bj_deal(bigint, text) from public;
grant  execute on function games.bj_deal(bigint, text) to authenticated;
revoke execute on function games.bj_hit(uuid, text) from public;
grant  execute on function games.bj_hit(uuid, text) to authenticated;
revoke execute on function games.bj_stand(uuid, text) from public;
grant  execute on function games.bj_stand(uuid, text) to authenticated;
revoke execute on function games.bj_double(uuid, text) from public;
grant  execute on function games.bj_double(uuid, text) to authenticated;

-- =============================================================================
-- CLOSE THE LEGACY SURFACE
-- =============================================================================
-- The bodies stay (audit trail, and a re-grant must still be safe), but no
-- client role can call them: bj_deal is the only door chips leave through now.

revoke execute on function games.place_bet(text, bigint, text) from public, authenticated;
revoke execute on function games.raise_bet(uuid, text) from public, authenticated;
revoke execute on function games.settle_bet(uuid, bigint, text, text) from public, authenticated;

-- Belt-and-braces inside settle_bet itself: even re-granted, it refuses any
-- hand the server dealt. Body otherwise identical to 20260825000100.
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
  perform games.assert_playable(v_uid);
  if p_payout is null or p_payout < 0 then
    raise exception 'payout cannot be negative' using errcode = '22023';
  end if;

  select * into v_bet from games.bets
  where id = p_bet_id and user_id = v_uid
  for update;
  if not found then
    raise exception 'no such hand' using errcode = '22023';
  end if;

  -- A server-dealt hand settles itself; a claimed payout for one is exactly
  -- the fabrication this migration exists to end.
  if exists (select 1 from games.bj_hands h where h.bet_id = p_bet_id) then
    raise exception 'server-dealt hands settle themselves' using errcode = '42501';
  end if;

  if v_bet.status <> 'open' then
    settled_payout := v_bet.payout;
    settled_net    := v_bet.net;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_bet.subteam;
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
    return;
  end if;

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

-- The retired rating RPCs accepted client-claimed hands/advantage; nothing
-- calls them since the ladder came down in 5.6.0. Bodies and history stay.
revoke execute on function games.apply_rated_session(text, integer, numeric, text) from public, authenticated;
revoke execute on function games.apply_rated_session_v3(text, integer, numeric, text) from public, authenticated;

-- =============================================================================
-- BAN CHECKS ON THE REMAINING ENTRY POINTS
-- =============================================================================

-- Arcade scores: identity trigger gains the ban gate. Body otherwise identical
-- to 20260605000000.
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
  perform games.assert_playable(new.user_id);
  select raw_user_meta_data into meta from auth.users where id = new.user_id;
  new.subteam      := nullif(meta->>'subteam', '');
  new.display_name := nullif(meta->>'display_name', '');
  new.created_at   := now();
  return new;
end;
$$;

-- Budget lookup: a banned player's casino never opens. Body otherwise
-- identical to 20260825000000.
create or replace function games.my_budget()
returns table (budget_subteam text, budget_balance bigint, budget_max_bet bigint)
language plpgsql
security definer
set search_path = games, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_subteam text;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform games.assert_playable(v_uid);
  v_subteam := games.subteam_of(v_uid);
  insert into games.budgets as b (subteam) values (v_subteam)
  on conflict (subteam) do nothing;
  select b.subteam, b.balance, games.max_bet(b.balance)
    into budget_subteam, budget_balance, budget_max_bet
  from games.budgets b where b.subteam = v_subteam;
  return next;
end;
$$;

-- Forfeit gains the ban gate and settles the private hand row too. Body
-- otherwise identical to 20260825000100.
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
  perform games.assert_playable(v_uid);
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
  update games.bj_hands h
     set phase = 'settled', updated_at = now()
   where h.bet_id = v_bet.id;
  forfeited_id    := v_bet.id;
  forfeited_stake := v_bet.stake;
  return next;
end;
$$;

-- =============================================================================
-- SMALL HARDENING
-- =============================================================================

-- games.max_bet touches no tables; pin its search_path so the advisor's
-- function_search_path_mutable warning stops pointing at money code.
alter function games.max_bet(bigint) set search_path = '';
