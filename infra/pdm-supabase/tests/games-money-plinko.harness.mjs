// Applies 20260825000000_games_money_plinko.sql to a throwaway PGlite (real
// Postgres, compiled to WASM) and exercises it end to end. Run it after
// touching that migration, BEFORE applying anything to prod.
//
//   npm i @electric-sql/pglite      # not a repo dependency; install ad hoc
//   node infra/pdm-supabase/tests/games-money-plinko.harness.mjs
//
// It catches what review does not: this file is how the "column reference
// subteam is ambiguous" bug in my_budget() and an off-by-one in the RTP
// self-check were both found, neither of which is visible by reading the SQL.
//
// PGlite is single-connection, so it cannot interleave two transactions.
// Genuine concurrency (the 5% cap under simultaneous drops) is covered by
// concurrency-hammer.mjs against a real server.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";

const MIGRATIONS = [
  new URL("../supabase/migrations/20260825000000_games_money_plinko.sql", import.meta.url),
  new URL("../supabase/migrations/20260825000100_games_blackjack_money.sql", import.meta.url),
];

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
const UID = "11111111-1111-1111-1111-111111111111";
const UID2 = "22222222-2222-2222-2222-222222222222";

const db = await PGlite.create({ extensions: { pgcrypto } });

// ---- Supabase-shaped stubs -------------------------------------------------
await db.exec(`
  create extension if not exists pgcrypto;
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
  create schema pm;
  create table pm.subteams (name text primary key);
  insert into pm.subteams values ('Aero'), ('Chassis'), ('Powertrain');
  create schema games;
  grant usage on schema games to authenticated;
  insert into auth.users values
    ('${UID}',  '{"subteam":"Aero","display_name":"Nick"}'),
    ('${UID2}', '{"subteam":"Aero","display_name":"Daniel"}');
`);

// ---- A. the migration applies ---------------------------------------------
try {
  for (const m of MIGRATIONS) await db.exec(readFileSync(m, "utf8"));
  check("both migrations apply cleanly (incl. the RTP self-check DO block)", true);
} catch (e) {
  check("migrations apply cleanly", false, `\n       ${e.message}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const asUser = async (uid) => db.query(`select set_config('test.uid', $1, false)`, [uid]);
await asUser(UID);

// ---- B. seeding ------------------------------------------------------------
const seeded = await db.query(`select subteam, balance from games.budgets order by subteam`);
check("seeds every pm subteam plus Unassigned at 10,000",
  seeded.rows.length === 4 && seeded.rows.every((r) => Number(r.balance) === 10000),
  JSON.stringify(seeded.rows));

// ---- C. max_bet behaviour (the same cases money.test.ts pins in TS) --------
for (const [balance, expected] of [[10000, 500], [8420, 421], [199, 9], [99, 5], [100, 5], [3, 3], [0, 0]]) {
  const r = await one(`select games.max_bet($1::bigint) as m`, [balance]);
  check(`max_bet(${balance}) = ${expected}`, Number(r.m) === expected, `got ${r.m}`);
}

// ---- D. payout parity with payoutChips() ----------------------------------
const payoutChips = (stake, cents) => Math.floor((stake * cents + 50) / 100);
let payoutOk = true, payoutBad = "";
for (const stake of [1, 5, 7, 13, 50, 99, 350, 421, 500]) {
  for (const cents of [15, 21, 38, 74, 93, 99, 110, 2600, 5000]) {
    const r = await one(`select ($1::bigint * $2::bigint + 50) / 100 as p`, [stake, cents]);
    if (Number(r.p) !== payoutChips(stake, cents)) {
      payoutOk = false; payoutBad = `${stake}x${cents}: sql ${r.p} vs ts ${payoutChips(stake, cents)}`;
    }
  }
}
check("SQL payout arithmetic matches payoutChips() on every case", payoutOk, payoutBad);

// ---- E. the payout table matches the TS table -----------------------------
const TS = JSON.parse(readFileSync(new URL("./plinko-tables.fixture.json", import.meta.url), "utf8"));
let tableOk = true, tableBad = "";
for (const [rows, byRisk] of Object.entries(TS)) {
  for (const [risk, cents] of Object.entries(byRisk)) {
    const got = (await db.query(
      `select multiplier_cents from games.plinko_payouts where rows=$1 and risk=$2 order by bucket`,
      [Number(rows), risk],
    )).rows.map((r) => Number(r.multiplier_cents));
    if (JSON.stringify(got) !== JSON.stringify(cents)) {
      tableOk = false; tableBad = `${rows}/${risk}: ${JSON.stringify(got)}`;
    }
  }
}
check("seeded payout table equals the TS table row for row", tableOk, tableBad);

// ---- F. a drop moves money and writes a ledger row ------------------------
const before = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
const d = await one(
  `select * from games.plinko_drop(16, 'high', 100::bigint, 'nonce-1')`);
const after = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("drop returns a path of one decision per row",
  d.drop_path.length === 16 && /^[LR]+$/.test(d.drop_path), d.drop_path);
check("bucket equals the number of rights in the path",
  d.drop_bucket === [...d.drop_path].filter((c) => c === "R").length);
check("budget moved by exactly the net", after - before === Number(d.drop_net),
  `before ${before} after ${after} net ${d.drop_net}`);
check("payout matches the table for the bucket that came up",
  Number(d.drop_payout) === payoutChips(100, Number(d.drop_multiplier)));
const ledger = await db.query(`select * from games.bets where nonce='nonce-1'`);
check("one settled ledger row written", ledger.rows.length === 1 && ledger.rows[0].status === "settled");
check("ledger row records balance_after", Number(ledger.rows[0].balance_after) === after);

// ---- G. idempotent replay: same nonce is the SAME ball, paid once ---------
const replay = await one(`select * from games.plinko_drop(16, 'high', 100::bigint, 'nonce-1')`);
const afterReplay = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("replaying a nonce returns the identical ball",
  replay.drop_path === d.drop_path && Number(replay.drop_payout) === Number(d.drop_payout));
check("replaying a nonce is flagged as a replay", replay.was_replay === true);
check("replaying a nonce does not move money again", afterReplay === after);
check("replaying a nonce does not write a second ledger row",
  (await db.query(`select 1 from games.bets where nonce='nonce-1'`)).rows.length === 1);

// ---- H. the 5% cap, checked against the live balance ----------------------
const cap = Number((await one(`select games.max_bet(balance) c from games.budgets where subteam='Aero'`)).c);
try {
  await db.query(`select * from games.plinko_drop(16,'high',$1::bigint,'over')`, [cap + 1]);
  check("a stake one chip over 5% is refused", false, "it was accepted");
} catch (e) {
  check("a stake one chip over 5% is refused", /5% of the budget/.test(e.message), e.message);
}
const capOk = await one(`select * from games.plinko_drop(16,'low',$1::bigint,'at-cap')`, [cap]);
check("a stake at exactly 5% is accepted", capOk.drop_path.length === 16);

// ---- I. a brand-new subteam gets a budget on first look -------------------
await db.query(`update auth.users set raw_user_meta_data='{"subteam":"Suspension"}'::jsonb where id=$1`, [UID2]);
await asUser(UID2);
const fresh = await one(`select * from games.my_budget()`);
check("an unseeded subteam is created at 10,000 on first look",
  fresh.budget_subteam === "Suspension" && Number(fresh.budget_balance) === 10000 && Number(fresh.budget_max_bet) === 500,
  JSON.stringify(fresh));
const freshDrop = await one(`select * from games.plinko_drop(8,'med',500::bigint,'fresh-1')`);
check("a drop against a never-seen subteam creates and locks its row in one statement",
  freshDrop.drop_path.length === 8);

// ---- J. no negative balance, ever, under sustained max betting ------------
await asUser(UID);
let minBalance = Infinity, negative = false, capViolation = false;
for (let i = 0; i < 1500; i++) {
  const b = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
  const c = Number((await one(`select games.max_bet($1::bigint) m`, [b])).m);
  if (c <= 0) break;
  if (c > b) capViolation = true;
  await db.query(`select * from games.plinko_drop(16,'high',$1::bigint,$2)`, [c, `hammer-${i}`]);
  const nb = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
  if (nb < 0) negative = true;
  minBalance = Math.min(minBalance, nb);
}
check("1500 max-bet drops never drive the balance negative", !negative);
check("the cap never exceeds the balance itself", !capViolation);
check("sustained max betting decays the budget geometrically", minBalance < 10000);
const finalB = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
console.log(`       (Aero ended at ${finalB} chips after 1500 max bets on 16-row HIGH)`);

// ---- K. ledger accounting reconciles --------------------------------------
const recon = await one(`
  select b.balance, b.staked, b.returned, b.bets,
         (select coalesce(sum(net),0) from games.bets where subteam='Aero') as ledger_net
  from games.budgets b where b.subteam='Aero'`);
check("balance = 10,000 + sum of the ledger's net column",
  10000 + Number(recon.ledger_net) === Number(recon.balance),
  `10000 + ${recon.ledger_net} != ${recon.balance}`);
check("lifetime staked/returned reconcile with the balance",
  10000 - Number(recon.staked) + Number(recon.returned) === Number(recon.balance));

// ---- L. duplicate nonce is refused at the constraint level ----------------
// (the arbiter the concurrent-duplicate path relies on)
try {
  await db.query(
    `insert into games.bets (user_id,subteam,game_id,nonce,stake,payout,balance_after)
     values ($1,'Aero','plinko','nonce-1',5,0,1)`, [UID]);
  check("unique (user_id, nonce) rejects a duplicate", false, "the duplicate inserted");
} catch (e) {
  check("unique (user_id, nonce) rejects a duplicate", /duplicate key|unique/i.test(e.message), e.message);
}

// ---- M. anon can't reach any of it ----------------------------------------
const grants = await db.query(`
  select has_function_privilege('anon','games.plinko_drop(integer,text,bigint,text)','execute') as drop_x,
         has_function_privilege('authenticated','games.plinko_drop(integer,text,bigint,text)','execute') as auth_x,
         has_table_privilege('authenticated','games.budgets','update') as auth_update,
         has_table_privilege('authenticated','games.bets','insert') as auth_insert`);
const g = grants.rows[0];
check("anon cannot execute plinko_drop", g.drop_x === false);
check("authenticated can execute plinko_drop", g.auth_x === true);
check("authenticated cannot write budgets directly", g.auth_update === false);
check("authenticated cannot write the ledger directly", g.auth_insert === false);

// ---- N. a unique_violation that is NOT our nonce must not be swallowed ----
// The concurrent-duplicate handler re-reads the winner's row; if there ISN'T
// one, the violation came from elsewhere and must propagate rather than be
// reported as a replay. Forced with a trigger, since PGlite is
// single-connection and can't produce a genuine concurrent insert.
await db.query(`update auth.users set raw_user_meta_data='{"subteam":"Chassis"}'::jsonb where id=$1`,[UID]);
await asUser(UID);
const balBefore = Number((await one(`select balance from games.budgets where subteam='Chassis'`)).balance);
await db.exec(`
  create function games.force_uv() returns trigger language plpgsql as $fn$
  begin
    if new.nonce = 'trap' then
      raise exception 'simulated unrelated collision' using errcode = '23505';
    end if;
    return new;
  end $fn$;
  create trigger bets_force_uv before insert on games.bets
    for each row execute function games.force_uv();
`);
try {
  await db.query(`select * from games.plinko_drop(8,'low',5::bigint,'trap')`);
  check("an unrelated unique_violation is re-raised, not reported as a replay", false, "it was swallowed");
} catch (e) {
  check("an unrelated unique_violation is re-raised, not reported as a replay",
    /simulated unrelated collision/.test(e.message), e.message);
}
const balAfter = Number((await one(`select balance from games.budgets where subteam='Chassis'`)).balance);
check("a failed drop moves no money at all", balAfter === balBefore, `${balBefore} -> ${balAfter}`);
await db.exec(`drop trigger bets_force_uv on games.bets; drop function games.force_uv();`);

// ---- O. a dead budget, and the only lever that revives it ----------------
await db.query(`select games.set_budget('Chassis', 0)`);
check("max_bet(0) is 0 — a zeroed budget has no legal bet",
  Number((await one(`select games.max_bet(0::bigint) m`)).m) === 0);
try {
  await db.query(`select * from games.plinko_drop(8,'low',5::bigint,'dead-1')`);
  check("a zeroed budget refuses every bet", false, "it accepted one");
} catch (e) {
  check("a zeroed budget refuses every bet", /cannot exceed 5%/.test(e.message), e.message);
}
await db.query(`select games.set_budget('Chassis', 10000)`);
const revived = await one(`select * from games.plinko_drop(8,'low',5::bigint,'revived-1')`);
check("set_budget revives a dead budget", revived.drop_path.length === 8);
const sb = (await db.query(`select
  has_function_privilege('authenticated','games.set_budget(text,bigint)','execute') a,
  has_function_privilege('anon','games.set_budget(text,bigint)','execute') n`)).rows[0];
check("set_budget is callable by neither authenticated nor anon", sb.a === false && sb.n === false);


// ---- P. blackjack two-phase betting ---------------------------------------
await db.query(`select games.set_budget('Aero', 10000)`);
await db.query(`update auth.users set raw_user_meta_data='{"subteam":"Aero","display_name":"Nick"}'::jsonb where id=$1`,[UID]);
await asUser(UID);
const bal0 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
const placed = await one(`select * from games.place_bet('blackjack', 100::bigint, 'bj-1')`);
const bal1 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("placing a bet debits the budget immediately", bal1 === bal0 - 100, `${bal0} -> ${bal1}`);
check("the hand is open, not settled",
  (await one(`select status from games.bets where id=$1`, [placed.bet_id])).status === "open");

// one open hand at a time
try {
  await db.query(`select * from games.place_bet('blackjack', 50::bigint, 'bj-2')`);
  check("a second hand can't be dealt while one is open", false, "it was allowed");
} catch (e) {
  check("a second hand can't be dealt while one is open", /already open/.test(e.message), e.message);
}

// replay of the deal
const rePlaced = await one(`select * from games.place_bet('blackjack', 100::bigint, 'bj-1')`);
const bal1b = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("replaying a deal returns the same hand and debits nothing more",
  rePlaced.bet_id === placed.bet_id && rePlaced.was_replay === true && bal1b === bal1);

// illegal payouts are refused
for (const bad of [37, 150, 199, 1]) {
  try {
    await db.query(`select * from games.settle_bet($1, $2::bigint, 'win', 'x')`, [placed.bet_id, bad]);
    check(`settling a ${bad}-chip payout on a 100 chip hand is refused`, false, "accepted");
  } catch (e) {
    check(`settling a ${bad}-chip payout on a 100 chip hand is refused`,
      /not one of the legal results/.test(e.message), e.message);
  }
}
// the 3:2 natural is legal on an unraised hand
const nat = await one(`select * from games.settle_bet($1, 250::bigint, 'blackjack', 's-1')`, [placed.bet_id]);
const bal2 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("a 3:2 natural settles and pays", Number(nat.settled_payout) === 250 && bal2 === bal1 + 250);
check("net is payout minus stake", Number(nat.settled_net) === 150);

// settling twice pays once
const reSettle = await one(`select * from games.settle_bet($1, 250::bigint, 'blackjack', 's-1')`, [placed.bet_id]);
const bal3 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("settling twice pays once", reSettle.was_replay === true && bal3 === bal2);

// ---- Q. doubling down -----------------------------------------------------
const d1 = await one(`select * from games.place_bet('blackjack', 100::bigint, 'bj-d')`);
const balD0 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
const raised = await one(`select * from games.raise_bet($1, 'r-1')`, [d1.bet_id]);
const balD1 = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("doubling debits a second stake", Number(raised.new_stake) === 200 && balD1 === balD0 - 100);
const reRaise = await one(`select * from games.raise_bet($1, 'r-1')`, [d1.bet_id]);
check("replaying a double debits nothing more",
  reRaise.was_replay === true &&
  Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance) === balD1);
try {
  await db.query(`select * from games.raise_bet($1, 'r-2')`, [d1.bet_id]);
  check("a hand can only be doubled once", false, "it doubled twice");
} catch (e) {
  check("a hand can only be doubled once", /already been doubled/.test(e.message), e.message);
}
try {
  await db.query(`select * from games.settle_bet($1, 500::bigint, 'blackjack', 's-2')`, [d1.bet_id]);
  check("the 3:2 natural is illegal on a doubled hand", false, "accepted");
} catch (e) {
  check("the 3:2 natural is illegal on a doubled hand",
    /not one of the legal results/.test(e.message), e.message);
}
await db.query(`select * from games.settle_bet($1, 400::bigint, 'win', 's-3')`, [d1.bet_id]);
check("a doubled hand pays 2x the doubled stake",
  Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance) === balD1 + 400);

// ---- R. abandoned hands are forfeit, never refunded -----------------------
const ab = await one(`select * from games.place_bet('blackjack', 75::bigint, 'bj-ab')`);
const balA = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
const forf = await one(`select * from games.forfeit_open_bet('blackjack')`);
const balB = Number((await one(`select balance from games.budgets where subteam='Aero'`)).balance);
check("forfeiting an abandoned hand returns nothing", balB === balA, `${balA} -> ${balB}`);
check("...and reports what was lost", forf.forfeited_id === ab.bet_id && Number(forf.forfeited_stake) === 75);
check("...and lands in the ledger as a settled loss",
  (await one(`select status, payout, detail->>'outcome' o from games.bets where id=$1`, [ab.bet_id])).o === "forfeit");
check("...so a new hand can be dealt again",
  (await one(`select * from games.place_bet('blackjack', 5::bigint, 'bj-after')`)).bet_id !== null);
await db.query(`select games.forfeit_open_bet('blackjack')`);
check("forfeiting with nothing open is a no-op, not an error",
  (await db.query(`select * from games.forfeit_open_bet('blackjack')`)).rows.length === 0);

// ---- S. blackjack money reconciles with the ledger ------------------------
// Scoped to the blackjack bets: set_budget above deliberately reset the
// balance without touching the ledger (it is an admin override, not a bet), so
// the reconciliation baseline is that reset rather than the original seed.
const bjRecon = await one(`
  select b.balance,
         (select coalesce(sum(net),0) from games.bets
           where subteam='Aero' and nonce like 'bj-%') led
  from games.budgets b where b.subteam='Aero'`);
check("every blackjack bet reconciles against the budget to the chip",
  10000 + Number(bjRecon.led) === Number(bjRecon.balance),
  `10000 + ${bjRecon.led} != ${bjRecon.balance}`);

const bjGrants = (await db.query(`select
  has_function_privilege('anon','games.place_bet(text,bigint,text)','execute') a,
  has_function_privilege('authenticated','games.settle_bet(uuid,bigint,text,text)','execute') s`)).rows[0];
check("anon cannot place bets", bjGrants.a === false);
check("authenticated can settle", bjGrants.s === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
