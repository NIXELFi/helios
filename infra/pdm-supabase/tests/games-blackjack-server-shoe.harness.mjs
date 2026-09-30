// Applies the FULL games migration chain in filename order to a throwaway
// PGlite (real Postgres, compiled to WASM) and exercises the server-shoe
// blackjack RPCs end to end. Run it after touching any games migration,
// BEFORE applying anything to prod.
//
//   npm i @electric-sql/pglite      # not a repo dependency; install ad hoc
//   node infra/pdm-supabase/tests/games-blackjack-server-shoe.harness.mjs
//
// Coverage: fresh-deploy ordering, shoe integrity (208 cards, 4 of each),
// hand valuation, replay idempotency (deal / hit / settle-crossing stand),
// hole-card and shoe secrecy, money conservation over hundreds of random
// hands, cross-user access, double rules, the grant matrix, the ban gate on
// every entry point, and the score-constraint boundaries.
//
// PGlite is single-connection, so it cannot interleave two transactions.
// Genuine concurrency (the 5% cap under simultaneous bets) is covered by
// concurrency-hammer.mjs against a real server.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";

const M = new URL("../supabase/migrations/", import.meta.url);
const MIGRATIONS = [
  "20260605000000_games_schema.sql",
  "20260622000700_games_scores_submission_nonce.sql",
  "20260810000000_games_blackjack_game_id.sql",
  "20260811000000_games_ratings.sql",
  "20260818000000_games_rating_money_v3.sql",
  "20260825000000_games_money_plinko.sql",
  "20260825000100_games_blackjack_money.sql",
  "20260826000000_fix_plinko_drop_search_path.sql",
  "20260829000000_games_score_hardening.sql",
  "20260829000100_games_blackjack_server_shoe.sql",
  "20260829000200_games_plinko_ban_gate.sql",
];

const UID = "11111111-1111-1111-1111-111111111111";
const UID2 = "22222222-2222-2222-2222-222222222222";
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(`
  create schema extensions;
  create extension if not exists pgcrypto with schema extensions;
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
  create schema pm;
  create table pm.subteams (name text primary key);
  insert into pm.subteams values ('Aero'), ('Chassis');
  create schema games;
  grant usage on schema games to authenticated;
  insert into auth.users values
    ('${UID}',  '{"subteam":"Aero","display_name":"Nick"}'),
    ('${UID2}', '{"subteam":"Aero","display_name":"Daniel"}');
`);

// ---- A. every migration applies in filename order on an empty DB -----------
for (const f of MIGRATIONS) {
  try { await db.exec(readFileSync(new URL(f, M), "utf8")); check(`applies: ${f}`, true); }
  catch (e) { check(`applies: ${f}`, false, `\n       ${e.message}`); process.exit(1); }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const asUser = (uid) => db.query(`select set_config('test.uid', $1, false)`, [uid]);
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
await asUser(UID);

// ---- B. shoe generation ----------------------------------------------------
const shoe = await one(`select games.bj_new_shoe() s`);
const cards = shoe.s;
check("bj_new_shoe returns 208 cards", cards.length === 208, `got ${cards.length}`);
{
  const counts = {};
  for (const c of cards) counts[`${c.rank}${c.suit}`] = (counts[`${c.rank}${c.suit}`] ?? 0) + 1;
  const keys = Object.keys(counts);
  check("52 distinct cards, 4 of each", keys.length === 52 && keys.every((k) => counts[k] === 4),
    `${keys.length} distinct`);
  const ranks = new Set(cards.map((c) => c.rank)), suits = new Set(cards.map((c) => c.suit));
  check("ranks/suits are the client's universe",
    [...ranks].sort().join() === ["10","2","3","4","5","6","7","8","9","A","J","K","Q"].sort().join() &&
    [...suits].sort().join() === "C,D,H,S", `${[...ranks]} / ${[...suits]}`);
}

// ---- C. hand value ---------------------------------------------------------
for (const [hand, total, soft] of [
  [`[{"rank":"A","suit":"S"},{"rank":"K","suit":"H"}]`, 21, true],
  [`[{"rank":"A","suit":"S"},{"rank":"A","suit":"H"}]`, 12, true],
  [`[{"rank":"A","suit":"S"},{"rank":"A","suit":"H"},{"rank":"9","suit":"D"}]`, 21, true],
  [`[{"rank":"A","suit":"S"},{"rank":"9","suit":"H"},{"rank":"9","suit":"D"}]`, 19, false],
  [`[{"rank":"10","suit":"S"},{"rank":"J","suit":"H"},{"rank":"Q","suit":"D"}]`, 30, false],
  [`[{"rank":"2","suit":"S"},{"rank":"3","suit":"H"}]`, 5, false],
  [`[{"rank":"A","suit":"S"},{"rank":"A","suit":"H"},{"rank":"A","suit":"D"},{"rank":"8","suit":"C"}]`, 21, true],
]) {
  const r = await one(`select * from games.bj_hand_value($1::jsonb)`, [hand]);
  check(`hand_value ${hand.replace(/"(rank|suit)":/g,"").replace(/[{}"]/g,"")} = ${total}/${soft}`,
    Number(r.total) === total && r.soft === soft, `got ${r.total}/${r.soft}`);
}

// ---- D. deal / hit / stand happy path + replay ------------------------------
const d1 = await one(`select * from games.bj_deal(100::bigint, 'n-1')`);
check("deal returns one row with a bet id", !!d1.bj_bet_id);
check("deal shows only the dealer up card while live",
  d1.bj_state !== "player" || d1.bj_dealer.length === 1, JSON.stringify(d1.bj_dealer));
check("deal debits the budget", Number(d1.new_balance) === 9900, `${d1.new_balance}`);
check("deal reports 204 cards left", Number(d1.bj_cards_left) === 204, `${d1.bj_cards_left}`);
check("deal is not a replay", d1.was_replay === false);

const d1r = await one(`select * from games.bj_deal(100::bigint, 'n-1')`);
check("deal replay is idempotent (same bet, no second debit)",
  d1r.bj_bet_id === d1.bj_bet_id && d1r.was_replay === true &&
  Number((await one(`select balance b from games.budgets where subteam='Aero'`)).b) === 9900);
check("deal replay still hides the hole card",
  d1r.bj_state !== "player" || d1r.bj_dealer.length === 1, JSON.stringify(d1r.bj_dealer));

check("a second deal while a hand is open is refused",
  /already open/.test(await err(`select * from games.bj_deal(50::bigint, 'n-2')`) ?? ""));

// ---- E. hit replay ---------------------------------------------------------
if (d1.bj_state === "player") {
  const h1 = await one(`select * from games.bj_hit($1, 'a-1')`, [d1.bj_bet_id]);
  const nCards = h1.bj_player.length;
  const h1r = await one(`select * from games.bj_hit($1, 'a-1')`, [d1.bj_bet_id]);
  check("hit replay does not draw a second card",
    h1r.bj_player.length === nCards && h1r.was_replay === true,
    `${nCards} -> ${h1r.bj_player.length}`);
  check("hit replay keeps the hole hidden while live",
    h1r.bj_state !== "player" || h1r.bj_dealer.length === 1, JSON.stringify(h1r.bj_dealer));
}

// ---- F. play out every remaining hand shape over many deals -----------------
let dealt = 0, settled = 0, badPayout = [], leaks = [], reshuffles = 0;
const legal = (stake, outcome, payout, raised) => {
  if (outcome === "lose") return payout === 0;
  if (outcome === "push") return payout === stake;
  if (outcome === "win") return payout === stake * 2;
  if (outcome === "blackjack") return !raised && payout === stake + Math.floor(stake * 1.5);
  return false;
};
// close the open hand first
{
  let t = await one(`select * from games.bj_state_of($1)`, [d1.bj_bet_id]);
  if (t.bj_state === "player") await db.query(`select * from games.bj_stand($1,'z-1')`, [d1.bj_bet_id]);
}
for (let i = 0; i < 400; i++) {
  const nonce = `d-${i}`;
  let t;
  try { t = await one(`select * from games.bj_deal(5::bigint, $1)`, [nonce]); }
  catch (e) { console.log("deal failed:", e.message); break; }
  dealt++;
  if (t.bj_reshuffled) reshuffles++;
  if (t.bj_state === "player" && t.bj_dealer.length !== 1) leaks.push(`deal ${i}: ${JSON.stringify(t.bj_dealer)}`);
  let guard = 0;
  while (t.bj_state === "player" && guard++ < 25) {
    const pv = await one(`select total from games.bj_hand_value($1::jsonb)`, [JSON.stringify(t.bj_player)]);
    const act = i % 3 === 0 && t.bj_player.length === 2 ? "double"
      : Number(pv.total) < 17 ? "hit" : "stand";
    t = await one(`select * from games.bj_${act}($1, $2)`, [t.bj_bet_id, `${nonce}-${guard}`]);
    if (t.bj_state === "player" && t.bj_dealer.length !== 1) leaks.push(`${nonce}-${guard}: ${JSON.stringify(t.bj_dealer)}`);
    if (t.bj_reshuffled) reshuffles++;
  }
  settled++;
  const raised = (await one(`select (detail->>'raised')::boolean r from games.bets where id=$1`, [t.bj_bet_id])).r;
  if (!legal(Number(t.bj_stake), t.bj_outcome, Number(t.bj_payout), raised)) {
    badPayout.push(`${nonce}: stake=${t.bj_stake} outcome=${t.bj_outcome} payout=${t.bj_payout} raised=${raised}`);
  }
  // dealer must be fully revealed at settle, and must have stood on >=17 or busted
  const dv = await one(`select * from games.bj_hand_value($1::jsonb)`, [JSON.stringify(t.bj_dealer)]);
  const pv = await one(`select * from games.bj_hand_value($1::jsonb)`, [JSON.stringify(t.bj_player)]);
  const playerBust = Number(pv.total) > 21;
  if (!playerBust && t.bj_dealer.length > 2 && Number(dv.total) < 17) {
    badPayout.push(`${nonce}: dealer stopped at ${dv.total}`);
  }
  // outcome must match the totals when neither side is a natural/bust shortcut
  if (!playerBust && Number(dv.total) >= 17) {
    const expect = Number(dv.total) > 21 || Number(pv.total) > Number(dv.total) ? "win"
      : Number(pv.total) < Number(dv.total) ? "lose" : "push";
    const isNat = t.bj_outcome === "blackjack" || (t.bj_player.length === 2 && Number(pv.total) === 21);
    if (!isNat && t.bj_outcome !== expect) {
      badPayout.push(`${nonce}: p=${pv.total} d=${dv.total} -> ${t.bj_outcome}, expected ${expect}`);
    }
  }
}
check(`played ${dealt} hands to settlement`, dealt > 300 && settled === dealt, `${dealt}/${settled}`);
check("no hole-card leak in any live response", leaks.length === 0, leaks.slice(0, 3).join(" | "));
check("every payout is one of the legal amounts and matches the totals",
  badPayout.length === 0, badPayout.slice(0, 5).join(" | "));
check(`shoe reshuffled ${reshuffles} times over the run`, reshuffles > 0, `${reshuffles}`);

// ---- G. money conservation --------------------------------------------------
const recon = await one(`
  select b.balance, b.staked, b.returned,
    (select coalesce(sum(net),0) from games.bets where subteam='Aero') led,
    (select coalesce(sum(stake),0) from games.bets where subteam='Aero') stk,
    (select coalesce(sum(payout),0) from games.bets where subteam='Aero') pay
  from games.budgets b where b.subteam='Aero'`);
check("budget reconciles to the ledger to the chip",
  10000 + Number(recon.led) === Number(recon.balance),
  `10000 + ${recon.led} != ${recon.balance}`);
check("staked/returned counters match the ledger",
  Number(recon.staked) === Number(recon.stk) && Number(recon.returned) === Number(recon.pay),
  `staked ${recon.staked}/${recon.stk} returned ${recon.returned}/${recon.pay}`);
check("no bet row left open", Number((await one(`select count(*) c from games.bets where status='open'`)).c) === 0);

// ---- H. settle-crossing replay + settled-hand refusal ----------------------
{
  const t = await one(`select * from games.bj_deal(5::bigint, 'sx-1')`);
  if (t.bj_state === "player") {
    const s = await one(`select * from games.bj_stand($1,'sx-a')`, [t.bj_bet_id]);
    const balAfter = Number((await one(`select balance b from games.budgets where subteam='Aero'`)).b);
    const s2 = await one(`select * from games.bj_stand($1,'sx-a')`, [t.bj_bet_id]);
    check("settle-crossing stand retry replays the same result",
      s2.was_replay === true && s2.bj_outcome === s.bj_outcome &&
      Number(s2.bj_payout) === Number(s.bj_payout) &&
      Number((await one(`select balance b from games.budgets where subteam='Aero'`)).b) === balAfter,
      `${s.bj_outcome}/${s.bj_payout} vs ${s2.bj_outcome}/${s2.bj_payout}`);
    check("a NEW nonce on a settled hand is refused (no second credit)",
      /already settled/.test(await err(`select * from games.bj_hit($1,'sx-b')`, [t.bj_bet_id]) ?? ""));
    check("settle_bet refuses a server-dealt hand",
      /settle themselves/.test(await err(
        `select * from games.settle_bet($1, 10::bigint, 'win', 'q')`, [t.bj_bet_id]) ?? "x"));
  }
}

// ---- I. cross-user access ---------------------------------------------------
{
  const mine = await one(`select * from games.bj_deal(5::bigint, 'x-1')`);
  await asUser(UID2);
  check("another player cannot hit my hand",
    /no such hand/.test(await err(`select * from games.bj_hit($1,'x-a')`, [mine.bj_bet_id]) ?? ""));
  check("another player cannot stand my hand",
    /no such hand/.test(await err(`select * from games.bj_stand($1,'x-b')`, [mine.bj_bet_id]) ?? ""));
  check("another player cannot double my hand",
    /no such hand/.test(await err(`select * from games.bj_double($1,'x-c')`, [mine.bj_bet_id]) ?? ""));
  await asUser(UID);
  let t = await one(`select * from games.bj_state_of($1)`, [mine.bj_bet_id]);
  if (t.bj_state === "player") await db.query(`select * from games.bj_stand($1,'x-z')`, [mine.bj_bet_id]);
}

// ---- J. double rules --------------------------------------------------------
{
  const t = await one(`select * from games.bj_deal(5::bigint, 'dd-1')`);
  if (t.bj_state === "player") {
    const h = await one(`select * from games.bj_hit($1,'dd-a')`, [t.bj_bet_id]);
    if (h.bj_state === "player") {
      check("double is refused after a hit (3+ cards)",
        /first two cards/.test(await err(`select * from games.bj_double($1,'dd-b')`, [t.bj_bet_id]) ?? ""));
      await db.query(`select * from games.bj_stand($1,'dd-c')`, [t.bj_bet_id]);
    }
  }
}

// ---- K. grants --------------------------------------------------------------
const g = await one(`select
  has_function_privilege('authenticated','games.bj_deal(bigint,text)','execute') deal,
  has_function_privilege('authenticated','games.bj_finish(uuid,text,jsonb,jsonb,text,bigint)','execute') finish,
  has_function_privilege('authenticated','games.bj_state_of(uuid)','execute') state_of,
  has_function_privilege('authenticated','games.bj_new_shoe()','execute') shoe,
  has_function_privilege('authenticated','games.settle_bet(uuid,bigint,text,text)','execute') settle,
  has_function_privilege('authenticated','games.place_bet(text,bigint,text)','execute') place,
  has_function_privilege('authenticated','games.raise_bet(uuid,text)','execute') raise,
  has_function_privilege('authenticated','games.apply_rated_session_v3(text,integer,numeric,text)','execute') rated,
  has_function_privilege('authenticated','games.plinko_drop(integer,text,bigint,text)','execute') plinko,
  has_function_privilege('authenticated','games.forfeit_open_bet(text)','execute') forfeit,
  has_function_privilege('authenticated','games.assert_playable(uuid)','execute') assertp,
  has_table_privilege('authenticated','games.bj_hands','select') hands,
  has_table_privilege('authenticated','games.bj_shoes','select') shoes,
  has_table_privilege('authenticated','games.banned_players','select') banned`);
check("authenticated CAN deal / plinko / forfeit", g.deal && g.plinko && g.forfeit);
check("authenticated CANNOT call bj_finish (arbitrary credit)", g.finish === false, `${g.finish}`);
check("authenticated CANNOT call bj_state_of / bj_new_shoe", g.state_of === false && g.shoe === false);
check("legacy place/raise/settle + rated RPCs are revoked",
  !g.settle && !g.place && !g.raise && !g.rated,
  `settle=${g.settle} place=${g.place} raise=${g.raise} rated=${g.rated}`);
check("authenticated CANNOT read bj_hands / bj_shoes / banned_players",
  !g.hands && !g.shoes && !g.banned, `${g.hands}/${g.shoes}/${g.banned}`);
check("assert_playable is not callable by clients", g.assertp === false, `${g.assertp}`);

// ---- L. the ban gate --------------------------------------------------------
await db.query(`insert into games.banned_players (user_id, reason) values ($1,'test')`, [UID]);
for (const [name, sql, params] of [
  ["bj_deal", `select * from games.bj_deal(5::bigint,'ban-1')`, []],
  ["plinko_drop", `select * from games.plinko_drop(8,'low',5::bigint,'ban-2')`, []],
  ["my_budget", `select * from games.my_budget()`, []],
  ["forfeit_open_bet", `select * from games.forfeit_open_bet('blackjack')`, []],
  ["settle_bet", `select * from games.settle_bet($1,0::bigint,'x','y')`, ["00000000-0000-0000-0000-000000000000"]],
  ["score insert", `insert into games.scores (game_id, score, submission_nonce) values ('snake', 5, gen_random_uuid())`, []],
]) {
  const m = await err(sql, params);
  check(`ban gate refuses ${name}`, /revoked/.test(m ?? ""), `${m}`);
}
// bj_hit/stand/double for a banned player
for (const fn of ["bj_hit", "bj_stand", "bj_double"]) {
  const m = await err(`select * from games.${fn}('00000000-0000-0000-0000-000000000000','b')`);
  check(`ban gate refuses ${fn}`, /revoked/.test(m ?? ""), `${m}`);
}
await db.query(`delete from games.banned_players where user_id=$1`, [UID]);
check("an unbanned player can play again", !!(await one(`select * from games.my_budget()`)).budget_subteam);

// ---- M. score constraints ---------------------------------------------------
const scoreCases = [
  ["2048 legit 2048", `('2048', 2048, gen_random_uuid())`, true],
  ["2048 not %4", `('2048', 2050, gen_random_uuid())`, false],
  ["2048 over 4M", `('2048', 4000004, gen_random_uuid())`, false],
  ["2048 zero", `('2048', 0, gen_random_uuid())`, true],
  ["breakout legit", `('breakout', 1250, gen_random_uuid())`, true],
  ["breakout not %10", `('breakout', 1255, gen_random_uuid())`, false],
  ["snake 397", `('snake', 397, gen_random_uuid())`, true],
  ["snake 401", `('snake', 401, gen_random_uuid())`, false],
  ["flappy 10000", `('flappy', 10000, gen_random_uuid())`, true],
  ["flappy 10001", `('flappy', 10001, gen_random_uuid())`, false],
  ["blackjack unconstrained", `('blackjack', 1337, gen_random_uuid())`, true],
];
for (const [name, vals, ok] of scoreCases) {
  const m = await err(`insert into games.scores (game_id, score, submission_nonce) values ${vals}`);
  check(`score constraint: ${name} ${ok ? "accepted" : "refused"}`, ok ? m === null : m !== null, `${m}`);
}
check("a score without a nonce is refused",
  (await err(`insert into games.scores (game_id, score) values ('snake', 10)`)) !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
