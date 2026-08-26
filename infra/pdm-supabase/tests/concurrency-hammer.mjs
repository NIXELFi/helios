// Proves the shared-money races are actually closed, against a REAL server.
//
// The PGlite harness next door can execute the migration but not interleave
// two transactions, so it cannot test the thing that matters most about a
// shared budget: what happens when two members of the same subteam bet at the
// same instant. This fires genuinely concurrent RPCs and checks the invariants
// that a lost update, a TOCTOU cap check, or a double-paid retry would break.
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_ANON_KEY=<anon> \
//   HELIOS_ACCESS_TOKEN=<a signed-in user's JWT> \
//   node infra/pdm-supabase/tests/concurrency-hammer.mjs
//
// The token is a normal member's — the point is that nothing privileged is
// needed to try to break this. Run it against a staging project, or against
// prod on a subteam whose budget you are willing to move: it really does spend
// chips (it reports the net at the end so you can set_budget them back).
//
// ⚠ Node 18+ for global fetch.

const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const TOKEN = process.env.HELIOS_ACCESS_TOKEN;
if (!URL_BASE || !ANON || !TOKEN) {
  console.error("set SUPABASE_URL, SUPABASE_ANON_KEY and HELIOS_ACCESS_TOKEN");
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const headers = {
  "Content-Type": "application/json",
  apikey: ANON,
  Authorization: `Bearer ${TOKEN}`,
  "Content-Profile": "games",
  "Accept-Profile": "games",
};

async function rpc(fn, args) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST", headers, body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `${res.status}`);
  return Array.isArray(body) ? body[0] : body;
}
const budget = () => rpc("my_budget", {});
const drop = (stake, nonce, rows = 8, risk = "low") =>
  rpc("plinko_drop", { p_rows: rows, p_risk: risk, p_stake: stake, p_nonce: nonce });

const stamp = Date.now();
const start = await budget();
console.log(`subteam ${start.budget_subteam}, balance ${start.budget_balance}, cap ${start.budget_max_bet}\n`);

// ---- 1. concurrent distinct drops: no lost updates ------------------------
// If the budget were read-modify-written instead of moved by a delta under the
// row lock, some of these debits would vanish and the balance would end up
// HIGHER than the ledger says it should.
const N = 40;
const stake = Math.max(5, Math.min(25, Number(start.budget_max_bet)));
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) => drop(stake, `hammer-${stamp}-${i}`)),
);
const okDrops = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
const refused = results.filter((r) => r.status === "rejected");
console.log(`  ${okDrops.length} accepted, ${refused.length} refused`);

const after = await budget();
const expected =
  Number(start.budget_balance) + okDrops.reduce((a, d) => a + Number(d.drop_net), 0);
check("40 concurrent drops: balance equals start + sum of every net (no lost update)",
  Number(after.budget_balance) === expected,
  `expected ${expected}, got ${after.budget_balance}`);
check("no accepted drop reported a negative balance",
  okDrops.every((d) => Number(d.new_balance) >= 0));
check("every refusal was the cap rule, not a crash",
  refused.every((r) => /5% of the budget|whole|positive/.test(String(r.reason?.message ?? r.reason))),
  refused.map((r) => String(r.reason?.message ?? r.reason)).slice(0, 3).join(" | "));
check("every payout matches the multiplier the server reported",
  okDrops.every((d) =>
    Number(d.drop_payout) === Math.floor((stake * Number(d.drop_multiplier) + 50) / 100)));
check("every path is one decision per row",
  okDrops.every((d) => d.drop_path.length === 8 && /^[LR]+$/.test(d.drop_path)));
check("bucket always equals the rights in the path",
  okDrops.every((d) => Number(d.drop_bucket) === [...d.drop_path].filter((c) => c === "R").length));

// ---- 2. the same nonce, fired concurrently: exactly one ball -------------
// This is the race PGlite can't reach. The up-front lookup misses in every
// caller (none has committed yet), so the unique index is the arbiter: one
// insert wins, the rest take unique_violation, roll their debit back, and
// return the winner's ball.
const dupNonce = `hammer-${stamp}-dup`;
const before2 = await budget();
const dups = await Promise.allSettled(Array.from({ length: 12 }, () => drop(stake, dupNonce)));
const dupOk = dups.filter((d) => d.status === "fulfilled").map((d) => d.value);
const after2 = await budget();

check("12 concurrent calls with one nonce all succeed", dupOk.length === 12,
  `${dupOk.length}/12`);
check("...and all return the SAME ball",
  new Set(dupOk.map((d) => d.drop_path)).size === 1,
  [...new Set(dupOk.map((d) => d.drop_path))].join(","));
check("...and the money moved exactly once",
  Number(after2.budget_balance) === Number(before2.budget_balance) + Number(dupOk[0].drop_net),
  `${before2.budget_balance} -> ${after2.budget_balance}, net ${dupOk[0].drop_net}`);
check("...and all but one are flagged as a replay",
  dupOk.filter((d) => d.was_replay === false).length <= 1,
  `${dupOk.filter((d) => d.was_replay === false).length} non-replays`);

// ---- 3. concurrent MAX bets: the cap is re-checked after the lock --------
// Each of these asks for 5% of the balance it saw. Serialised, later ones must
// be measured against the SHRUNKEN balance — if the cap were checked before
// the lock, several would slip through at more than 5% of what's really there.
const before3 = await budget();
const cap = Number(before3.budget_max_bet);
const maxDrops = await Promise.allSettled(
  Array.from({ length: 10 }, (_, i) => drop(cap, `hammer-${stamp}-max-${i}`)),
);
const maxOk = maxDrops.filter((r) => r.status === "fulfilled").map((r) => r.value);
const after3 = await budget();
check("concurrent max bets never drive the balance below zero",
  Number(after3.budget_balance) >= 0 && maxOk.every((d) => Number(d.new_balance) >= 0),
  `final ${after3.budget_balance}`);
check("concurrent max bets reconcile exactly",
  Number(after3.budget_balance) ===
    Number(before3.budget_balance) + maxOk.reduce((a, d) => a + Number(d.drop_net), 0));

const end = await budget();
const moved = Number(end.budget_balance) - Number(start.budget_balance);
console.log(`\n${pass} passed, ${fail} failed`);
console.log(
  `net effect on ${end.budget_subteam}: ${moved >= 0 ? "+" : ""}${moved} chips ` +
  `(${start.budget_balance} -> ${end.budget_balance})`,
);
console.log(
  `to undo: select games.set_budget('${end.budget_subteam}', ${start.budget_balance});`,
);
process.exit(fail ? 1 : 0);
