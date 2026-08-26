-- 20260825000000_games_money_plinko.sql
--
-- The casino gets real money, and plinko gets built on it.
--
-- WHAT CHANGES
-- ------------
-- Every SUBTEAM has one budget, seeded at 10,000 chips, and every member
-- spends from it. There is no per-player bankroll and no buy-in: the chips on
-- the table belong to the team. A single bet may stake at most 5% of whatever
-- the budget holds at the moment the bet is placed.
--
-- Because that cap is a PERCENTAGE of the live balance, the stake shrinks as
-- the budget shrinks, so losing decays the budget geometrically instead of
-- marching it to zero: a subteam that keeps losing gets poor slowly rather
-- than broke suddenly.
--
-- ⚠ That does NOT make ruin impossible, and it is worth being precise because
--   the geometric argument is seductive. It is continuous-maths, and integer
--   chips break it: games.max_bet floors the cap at the 5-chip table minimum,
--   and 5 chips out of a 5-chip balance is 100% of the budget, not 5%. Ruin is
--   reachable from below. Measured against this exact table, sustained MAX
--   betting on the swingiest board (16 rows, high) empties a 10,000 budget
--   24% of the time within 1,500 drops and 97% within 5,000; at a flat
--   100-chip stake it is 0.8% and 40%. A budget at zero is DEAD — max_bet(0)
--   is 0, so there is no legal bet left — until someone tops it up.
--
-- The floor is kept anyway, because it is also the only way back: a subteam
-- down to 40 chips can still stake 5, and 5 on a 50x is 250. It buys recovery
-- at the price of making zero reachable. games.set_budget is the top-up lever
-- for when a subteam does hit the wall.
--
-- THE THING THIS MIGRATION IS REALLY ABOUT: RACES
-- -----------------------------------------------
-- Shared money means concurrent writers by design — two members of the same
-- subteam playing at once is the normal case, not the edge case. Four races
-- are possible and each is closed structurally rather than by hoping:
--
--   1. LOST UPDATE. Two drops read 10,000, both write 9,500, one debit
--      vanishes. Closed by never reading the balance into a variable and
--      writing it back: the budget always moves by `balance = balance ± n`
--      under a row lock, and the lock is taken by the same statement that
--      creates the row (INSERT .. ON CONFLICT DO UPDATE always locks and
--      always returns, unlike DO NOTHING, which can return no row at all when
--      it loses the insert race).
--
--   2. TIME-OF-CHECK/TIME-OF-USE on the 5% cap. Read the balance, validate the
--      stake, then debit — and a concurrent drop in between makes the stake
--      legal against a balance that no longer exists. Closed by validating
--      AFTER the lock is held, against the value that statement returned.
--      Serialised, the second drop is measured against the post-first balance,
--      which is exactly the intended meaning of "5% per bet".
--
--   3. DOUBLE-PAY on retry. A flaky network, a double-clicked DROP, or a
--      client-side re-render must not roll a second ball or move money twice.
--      Closed by `unique (user_id, nonce)` plus a replay path that returns the
--      original outcome verbatim. Note the ordering subtlety: a CONCURRENT
--      duplicate can't be caught by the up-front lookup (neither call sees the
--      other yet), so the insert itself is the arbiter — the loser blocks on
--      the unique index, gets unique_violation once the winner commits, rolls
--      its subtransaction back (undoing its debit) and re-reads the winner's
--      row. Both callers get the same ball.
--
--   4. NEGATIVE BALANCE. Closed twice over: the cap check can't pass a stake
--      larger than the balance, and `check (balance >= 0)` refuses to store
--      one anyway.
--
-- Deadlock is impossible here because a call locks exactly one budget row and
-- never holds two, so there is no cycle to form.
--
-- WHO DECIDES WHERE THE BALL LANDS
-- --------------------------------
-- This function does. The path is generated server-side from pgcrypto, the
-- bucket and payout are resolved from a table the client cannot write, and the
-- money moves in the same transaction. The client is handed a finished result
-- to animate. That is a real change of posture from the arcade games (whose
-- scores are client-reported and merely bragging rights) and from blackjack's
-- client-side shoe — it is warranted because plinko spends the team's money,
-- and an outcome the client picked would be an outcome the client could pick
-- again.
--
-- ⚠ games.max_bet and the payout arithmetic are duplicated in
--   apps/desktop/src/modules/games/money.ts and games/plinko/logic.ts, and
--   pinned to this file by __tests__/money.sql-parity.test.ts. The copies over
--   there let the cabinet grey out chips and draw the board; THIS copy is the
--   one that moves money.

-- =============================================================================
-- BUDGETS
-- =============================================================================

create table games.budgets (
  subteam    text primary key,
  balance    bigint not null default 10000 check (balance >= 0),
  -- Lifetime counters, so the ledger chart has an origin even after old bet
  -- rows are aged out.
  staked     bigint not null default 0 check (staked >= 0),
  returned   bigint not null default 0 check (returned >= 0),
  bets       integer not null default 0 check (bets >= 0),
  seeded_at  timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table games.budgets is
  'One shared chip balance per subteam. Only games.plinko_drop (and, later, the blackjack bet RPCs) may move it; direct writes are not granted to anyone but service_role.';

-- =============================================================================
-- BET LEDGER
-- =============================================================================
-- One row per settled bet. This is the audit trail, the idempotency key, and
-- the source for every money board and the per-member ledger the casino shows.
-- `status` and `settled_at` exist for blackjack's two-phase flow (a hand is
-- open while it is being played); plinko only ever writes 'settled'.

create table games.bets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  subteam       text not null references games.budgets(subteam) on update cascade,
  game_id       text not null check (game_id in ('blackjack','plinko')),
  nonce         text not null,
  stake         bigint not null check (stake > 0),
  payout        bigint not null default 0 check (payout >= 0),
  net           bigint generated always as (payout - stake) stored,
  status        text not null default 'settled' check (status in ('open','settled','void')),
  -- Game-specific result: for plinko the path, bucket and multiplier, so a
  -- drop can be replayed and audited without re-deriving anything.
  detail        jsonb not null default '{}'::jsonb,
  balance_after bigint not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,
  unique (user_id, nonce)
);

create index idx_games_bets_ledger on games.bets (subteam, created_at desc);
create index idx_games_bets_board on games.bets (game_id, user_id);
create index idx_games_bets_week on games.bets (created_at);

-- =============================================================================
-- PLINKO PAYOUT TABLE
-- =============================================================================
-- Multipliers are integer HUNDREDTHS of the stake. That is not cosmetic: it
-- keeps `stake * multiplier` exact integer arithmetic on both sides of the
-- wire. A numeric/float multiplier lets Postgres and JS disagree on the
-- half-chip cases, and rounding then turns the disagreement into a whole chip
-- the player can see.
--
-- Every board returns ~99% — deliberately close to blackjack's ~1.1% chart
-- edge, so choosing plinko is a choice about variance rather than a worse
-- deal. Multipliers rise monotonically from the centre outward, and the top of
-- each table is capped far below a real casino's 1000x: one bet is at most 5%
-- of the budget, so a 1000x would hand a single lucky drop fifty times
-- everything the subteam owns.

create table games.plinko_payouts (
  rows             smallint not null check (rows in (8, 12, 16)),
  risk             text not null check (risk in ('low', 'med', 'high')),
  bucket           smallint not null check (bucket >= 0),
  multiplier_cents integer not null check (multiplier_cents > 0),
  primary key (rows, risk, bucket)
);

insert into games.plinko_payouts (rows, risk, bucket, multiplier_cents)
select rows, risk, bucket - 1, cents
from (
  values
    (8::smallint,  'low',  array[220,170,120,93,72,93,120,170,220]),
    (8::smallint,  'med',  array[600,300,150,75,36,75,150,300,600]),
    (8::smallint,  'high', array[1200,430,150,55,21,55,150,430,1200]),
    (12::smallint, 'low',  array[300,230,180,140,110,87,73,87,110,140,180,230,300]),
    (12::smallint, 'med',  array[1200,670,370,210,110,64,38,64,110,210,370,670,1200]),
    (12::smallint, 'high', array[2600,1200,520,240,110,47,15,47,110,240,520,1200,2600]),
    (16::smallint, 'low',  array[400,320,260,200,160,130,100,84,74,84,100,130,160,200,260,320,400]),
    (16::smallint, 'med',  array[1800,1100,680,420,260,160,99,61,38,61,99,160,260,420,680,1100,1800]),
    (16::smallint, 'high', array[5000,2500,1300,660,330,170,86,44,21,44,86,170,330,660,1300,2500,5000])
) as t(rows, risk, cents_arr)
cross join lateral unnest(t.cents_arr) with ordinality as u(cents, bucket);

-- Self-check: every board must have one multiplier per bucket and return
-- between 98.85% and 99.10%. A fat-fingered multiplier fails the deploy rather
-- than quietly changing the house edge under everybody.
do $$
declare
  r record;
  v_rtp numeric;
begin
  for r in select distinct rows, risk from games.plinko_payouts loop
    if (select count(*) from games.plinko_payouts p
         where p.rows = r.rows and p.risk = r.risk) <> r.rows + 1 then
      raise exception 'plinko table %/% has the wrong bucket count', r.rows, r.risk;
    end if;
    -- Σ C(n,k)/2^n · m_k, with the binomial coefficient built multiplicatively.
    -- C(n,0) is an EMPTY product, so generate_series(0,-1) yields no rows and
    -- sum(ln(..)) is null — coalesce it to 1 rather than letting sum() drop
    -- the term, which silently understates the edge bucket.
    select sum(
             coalesce((select exp(sum(ln((r.rows - i)::numeric / (i + 1)::numeric)))
                         from generate_series(0, p.bucket - 1) i), 1)
             * (p.multiplier_cents::numeric / 100)
           ) / (2::numeric ^ r.rows)
      into v_rtp
      from games.plinko_payouts p
     where p.rows = r.rows and p.risk = r.risk;
    if v_rtp < 0.9885 or v_rtp > 0.9910 then
      raise exception 'plinko table %/% returns %, outside the 1%% house edge band',
        r.rows, r.risk, round(v_rtp, 5);
    end if;
  end loop;
end;
$$;

-- =============================================================================
-- HELPERS
-- =============================================================================

-- Which budget a player spends from. Subteam lives in auth metadata (same
-- source games.scores denormalises from); anyone without one shares the
-- 'Unassigned' pot, which is a real budget rather than a special case, so a
-- new signup can play before a lead has filed them anywhere.
create or replace function games.subteam_of(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = games, public, auth
as $$
  select coalesce(nullif(u.raw_user_meta_data->>'subteam', ''), 'Unassigned')
  from auth.users u where u.id = p_uid;
$$;

-- The largest single bet a budget allows. Integer division truncates toward
-- zero, which for a positive balance is the floor — so the cap can never round
-- UP past 5%. The greatest(5, ...) floor keeps a subteam that has ground its
-- budget under 100 chips merely poor rather than locked out: without it, 5% of
-- 99 is 4 and there is no legal bet left to place. least(balance, ...) stops
-- that floor overdrawing a nearly-empty budget.
create or replace function games.max_bet(p_balance bigint)
returns bigint
language sql
immutable
as $$
  select case
           when p_balance is null or p_balance <= 0 then 0::bigint
           else least(p_balance, greatest(5::bigint, (p_balance * 5) / 100))
         end;
$$;

-- The caller's budget, creating it on first look so a brand-new subteam never
-- sees an empty casino. Returns the cap alongside the balance so the cabinet
-- has one round trip, not two.
-- OUT names are prefixed for the same reason they are on plinko_drop: a
-- RETURNS TABLE column becomes a plpgsql variable, so a bare `subteam` in
-- `on conflict (subteam)` below resolves to the variable and the function
-- fails at CALL time with "column reference is ambiguous" rather than at
-- deploy. Same trap the v2 ratings migration hit.
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
  v_subteam := games.subteam_of(v_uid);
  insert into games.budgets as b (subteam) values (v_subteam)
  on conflict (subteam) do nothing;
  select b.subteam, b.balance, games.max_bet(b.balance)
    into budget_subteam, budget_balance, budget_max_bet
  from games.budgets b where b.subteam = v_subteam;
  return next;
end;
$$;

-- Top-up / correction lever. A budget CAN reach zero (see the header), and a
-- subteam sitting on zero has no legal bet and no way back on its own. Rather
-- than build a faucet before anyone has asked for one, this is the manual
-- knob: deliberately granted to NOBODY, so it is reachable only with the
-- service role (Supabase dashboard / Management API) and can't be called from
-- the app by anyone at all. Whatever the eventual policy turns out to be —
-- weekly stipend, seasonal reset, skill-based comp — it can be built on this
-- without another migration.
create or replace function games.set_budget(p_subteam text, p_balance bigint)
returns bigint
language plpgsql
security definer
set search_path = games, public
as $$
declare
  v_new bigint;
begin
  if p_balance is null or p_balance < 0 then
    raise exception 'balance must be zero or positive' using errcode = '22023';
  end if;
  insert into games.budgets as b (subteam, balance)
  values (p_subteam, p_balance)
  on conflict (subteam) do update set balance = p_balance, updated_at = now()
  returning b.balance into v_new;
  return v_new;
end;
$$;

revoke execute on function games.set_budget(text, bigint) from public;

-- =============================================================================
-- PLINKO DROP
-- =============================================================================

create or replace function games.plinko_drop(
  p_rows  integer,
  p_risk  text,
  p_stake bigint,
  p_nonce text
)
-- OUT names deliberately avoid the column names on games.bets/budgets: a
-- RETURNS TABLE column becomes a plpgsql variable, and an unqualified
-- reference would then be ambiguous at runtime rather than at deploy.
returns table (
  drop_path        text,
  drop_bucket      integer,
  drop_multiplier  integer,
  drop_payout      bigint,
  drop_net         bigint,
  new_balance      bigint,
  new_max_bet      bigint,
  was_replay       boolean
)
language plpgsql
security definer
-- `extensions` is REQUIRED here: this function calls gen_random_bytes(), which is
-- pgcrypto, and Supabase installs pgcrypto into the "extensions" schema. Without
-- it the drop fails at run time with "function gen_random_bytes(integer) does not
-- exist" while every other RPC keeps working (gen_random_uuid is core, so the
-- table defaults gave no warning). Matches pm.sync_gcal's search_path convention.
set search_path = games, public, auth, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_subteam text;
  v_meta    jsonb;
  v_prior   record;
  v_balance bigint;
  v_cap     bigint;
  v_bytes   bytea;
  v_path    text := '';
  v_bucket  integer := 0;
  v_cents   integer;
  v_payout  bigint;
  i         integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_rows is null or p_rows not in (8, 12, 16) then
    raise exception 'no such board: % rows', p_rows using errcode = '22023';
  end if;
  if p_risk is null or p_risk not in ('low', 'med', 'high') then
    raise exception 'no such risk: %', p_risk using errcode = '22023';
  end if;
  if p_stake is null or p_stake <= 0 then
    raise exception 'stake must be a positive whole number of chips' using errcode = '22023';
  end if;
  if p_nonce is null or length(p_nonce) = 0 then
    raise exception 'nonce required' using errcode = '22023';
  end if;

  v_subteam := games.subteam_of(v_uid);

  -- Fast path: this drop already happened. Hand back the same ball rather than
  -- rolling a new one — a retry must never be a re-roll, and must never pay
  -- twice. (The CONCURRENT duplicate can't be caught here; see the exception
  -- handler below, which is where that one is arbitrated.)
  select b.detail, b.payout, b.net, b.balance_after
    into v_prior
  from games.bets b
  where b.user_id = v_uid and b.nonce = p_nonce;
  if found then
    drop_path       := v_prior.detail->>'path';
    drop_bucket     := (v_prior.detail->>'bucket')::integer;
    drop_multiplier := (v_prior.detail->>'multiplier_cents')::integer;
    drop_payout     := v_prior.payout;
    drop_net        := v_prior.net;
    -- Report the CURRENT balance, not the one this bet left behind: teammates
    -- have very likely moved it since, and showing a stale number as though it
    -- were live is worse than showing nothing.
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_subteam;
    new_balance := coalesce(new_balance, v_prior.balance_after);
    new_max_bet := games.max_bet(new_balance);
    was_replay  := true;
    return next;
    return;
  end if;

  begin
    -- Create-or-lock in ONE statement. ON CONFLICT DO UPDATE (rather than DO
    -- NOTHING) is load-bearing: it takes the row lock and returns the row in
    -- both the created and the already-existed case, so there is no window in
    -- which a concurrent creator leaves us with nothing to lock. Everything
    -- below runs with this subteam's budget row held.
    insert into games.budgets as b (subteam)
    values (v_subteam)
    on conflict (subteam) do update set updated_at = now()
    returning b.balance into v_balance;

    -- Cap checked AFTER the lock, against the balance that statement just
    -- returned. Checking before the lock would be the TOCTOU race: a
    -- concurrent drop could shrink the budget between the check and the debit
    -- and let this stake through at more than 5% of what's actually there.
    v_cap := games.max_bet(v_balance);
    if p_stake > v_cap then
      raise exception 'one bet cannot exceed 5%% of the budget (max % chips, balance %)',
        v_cap, v_balance using errcode = '22023';
    end if;

    -- Resolve the ball. One byte per row, low bit taken — uniform over the
    -- byte, so uniform over L/R. Generated here, from pgcrypto, so the outcome
    -- exists only after the money is committed to moving.
    v_bytes := gen_random_bytes(p_rows);
    for i in 1..p_rows loop
      if (get_byte(v_bytes, i - 1) & 1) = 1 then
        v_path := v_path || 'R';
        v_bucket := v_bucket + 1;
      else
        v_path := v_path || 'L';
      end if;
    end loop;

    select p.multiplier_cents into v_cents
    from games.plinko_payouts p
    where p.rows = p_rows and p.risk = p_risk and p.bucket = v_bucket;
    if v_cents is null then
      raise exception 'no payout for %/% bucket %', p_rows, p_risk, v_bucket;
    end if;

    -- Integer arithmetic end to end; +50 before the divide is round-half-up,
    -- which is what payoutChips() does in TS.
    v_payout := (p_stake * v_cents + 50) / 100;

    -- Never read-modify-write: the balance moves by a delta, under the lock
    -- taken above, so a concurrent drop's debit cannot be lost.
    update games.budgets b
       set balance    = b.balance - p_stake + v_payout,
           staked     = b.staked + p_stake,
           returned   = b.returned + v_payout,
           bets       = b.bets + 1,
           updated_at = now()
     where b.subteam = v_subteam
    returning b.balance into new_balance;

    select raw_user_meta_data into v_meta from auth.users where id = v_uid;

    insert into games.bets (
      user_id, subteam, game_id, nonce, stake, payout, status, detail,
      balance_after, display_name, settled_at
    ) values (
      v_uid, v_subteam, 'plinko', p_nonce, p_stake, v_payout, 'settled',
      jsonb_build_object(
        'path', v_path, 'bucket', v_bucket, 'rows', p_rows,
        'risk', p_risk, 'multiplier_cents', v_cents
      ),
      new_balance, nullif(v_meta->>'display_name', ''), now()
    );

    drop_path       := v_path;
    drop_bucket     := v_bucket;
    drop_multiplier := v_cents;
    drop_payout     := v_payout;
    drop_net        := v_payout - p_stake;
    new_max_bet     := games.max_bet(new_balance);
    was_replay      := false;
    return next;

  exception when unique_violation then
    -- A concurrent call with the same nonce beat us to it. Our insert blocked
    -- on the unique index until that transaction committed, so its row is
    -- visible now; this subtransaction's debit has just been rolled back, so
    -- the money moved exactly once. Return ITS ball, so both callers agree.
    select b.detail, b.payout, b.net into v_prior
    from games.bets b
    where b.user_id = v_uid and b.nonce = p_nonce;
    if not found then
      raise; -- not the nonce after all — don't swallow a real constraint bug
    end if;
    drop_path       := v_prior.detail->>'path';
    drop_bucket     := (v_prior.detail->>'bucket')::integer;
    drop_multiplier := (v_prior.detail->>'multiplier_cents')::integer;
    drop_payout     := v_prior.payout;
    drop_net        := v_prior.net;
    select bg.balance into new_balance from games.budgets bg where bg.subteam = v_subteam;
    new_max_bet     := games.max_bet(new_balance);
    was_replay      := true;
    return next;
  end;
end;
$$;

-- =============================================================================
-- RLS + GRANTS
-- =============================================================================
-- Reads are open to the org (same posture as games.scores — the standings are
-- the point). Writes go through the SECURITY DEFINER RPCs only: no role but
-- service_role holds insert/update/delete on either table, so the 5% cap and
-- the ledger row cannot be bypassed by talking to PostgREST directly.

alter table games.budgets enable row level security;
alter table games.bets enable row level security;
alter table games.plinko_payouts enable row level security;

create policy budgets_read_authed on games.budgets
  for select to authenticated using (true);
create policy bets_read_authed on games.bets
  for select to authenticated using (true);
create policy plinko_payouts_read_authed on games.plinko_payouts
  for select to authenticated using (true);

grant select on games.budgets, games.bets, games.plinko_payouts to authenticated;
revoke all on games.budgets, games.bets, games.plinko_payouts from anon;

-- Postgres grants EXECUTE to PUBLIC on every new function and anon inherits it
-- through PUBLIC, so revoking "from anon" alone is a no-op that merely looks
-- like hardening. Revoke PUBLIC first, then grant the one role back. (Verified
-- with has_function_privilege after the v5.4.1 incident.)
revoke execute on function games.plinko_drop(integer, text, bigint, text) from public;
grant  execute on function games.plinko_drop(integer, text, bigint, text) to authenticated;
revoke execute on function games.my_budget() from public;
grant  execute on function games.my_budget() to authenticated;
revoke execute on function games.subteam_of(uuid) from public;
revoke execute on function games.max_bet(bigint) from public;
grant  execute on function games.max_bet(bigint) to authenticated;

-- =============================================================================
-- BOARDS
-- =============================================================================

-- The casino standings: chips on hand, per subteam. Unlike the arcade's
-- placement-points scoring there is nothing to normalise across games — every
-- casino game spends the same pot, so the pot IS the score.
create view games.leaderboard_budgets
  with (security_invoker = true) as
select subteam, balance, staked, returned, bets, updated_at
from games.budgets;

-- Per member, per game: chips contributed to (or taken from) the budget.
-- Negative values are normal and are the point — this is a ledger, not a high
-- score table. Shaped like the other boards so the client's fetchBoard path is
-- unchanged.
create view games.leaderboard_money_alltime
  with (security_invoker = true) as
select
  game_id,
  user_id,
  sum(net)::bigint as best,
  (array_agg(display_name order by created_at desc))[1] as display_name,
  (array_agg(subteam      order by created_at desc))[1] as subteam
from games.bets
where status = 'settled'
group by game_id, user_id;

create view games.leaderboard_money_weekly
  with (security_invoker = true) as
select
  game_id,
  user_id,
  sum(net)::bigint as best,
  (array_agg(display_name order by created_at desc))[1] as display_name,
  (array_agg(subteam      order by created_at desc))[1] as subteam
from games.bets
where status = 'settled' and created_at >= date_trunc('week', now())
group by game_id, user_id;

-- The ledger the casino shows: what just happened, to whose money.
create view games.ledger_recent
  with (security_invoker = true) as
select id, subteam, user_id, display_name, game_id, stake, payout, net,
       detail, balance_after, created_at
from games.bets
where status = 'settled'
order by created_at desc;

grant select on games.leaderboard_budgets, games.leaderboard_money_alltime,
  games.leaderboard_money_weekly, games.ledger_recent to authenticated;

-- =============================================================================
-- SEED
-- =============================================================================
-- Every subteam that exists today, plus the Unassigned pot, starts at 10,000.
-- Subteams created later are seeded on first look by games.my_budget().

insert into games.budgets (subteam)
select name from pm.subteams
union
select 'Unassigned'
on conflict (subteam) do nothing;
