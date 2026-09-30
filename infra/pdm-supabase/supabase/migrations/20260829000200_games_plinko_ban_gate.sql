-- 20260829000200_games_plinko_ban_gate.sql
--
-- 20260829000100 added games.banned_players and gated every games entry point
-- except this one: plinko_drop was the single RPC not recreated, found by
-- the ban-gate E2E (a banned account dropped a real ball). Body is verbatim
-- 20260825000000 (search_path already carries `extensions` per 20260826000000)
-- plus the one assert_playable line every sibling entry point has.

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
  perform games.assert_playable(v_uid);
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
