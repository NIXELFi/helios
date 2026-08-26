// The casino's shared-money rules.
//
// Every subteam has ONE budget, and every member spends from it. There is no
// per-player bankroll and no buy-in: the chips on the table are the team's.
// The only brake is that a single bet can never be more than a fixed fraction
// of what the budget currently holds.
//
// That fraction does more work than it looks like. Because the cap is a
// PERCENTAGE of the live balance, the stake shrinks as the budget shrinks — so
// losing decays the budget geometrically instead of marching it to zero, and a
// subteam that keeps losing gets poor slowly rather than broke suddenly.
//
// ⚠ It does NOT make ruin impossible. That argument is continuous-maths and
//   integer chips break it: MIN_BET floors the cap at 5, and 5 chips out of a
//   5-chip balance is 100% of the budget, not 5%. Measured on the swingiest
//   board, sustained MAX betting empties a 10,000 budget 24% of the time
//   within 1,500 drops. A budget at zero is dead — maxBet(0) is 0 — until an
//   admin tops it up with games.set_budget.
//
// It also sets the pace, and the knob is quadratic. Betting a fixed fraction f
// of a bankroll on a negative-edge game changes the log of the balance by
// roughly `f·edge − f²σ²/2` per bet (σ ≈ 1.15 for blackjack, ~2.5 for plinko on
// high risk). At f = 5% most of the decay is that second term — the volatility
// drag, not the house edge — so halving the fraction roughly quadruples how
// long a budget lasts. If subteams blow up too fast, BET_FRACTION is the one
// number to turn.
//
// ⚠ These rules are duplicated in SQL (games.max_bet / games.place_bet). The
//   SQL copy is the one that counts — the client copy exists only so the
//   cabinet can grey out chips it knows the server would refuse. They are
//   pinned to each other by __tests__/money.sql-parity.test.ts.

/** Share of the subteam budget one bet may stake. */
export const BET_FRACTION = 0.05;

/** The table minimum, in chips. Also the floor under the 5% cap: a budget too
 *  small for 5% to reach this still gets to place one minimum bet. */
export const MIN_BET = 5;

/** What every subteam starts with, and what a fresh budget row is seeded at. */
export const STARTING_BUDGET = 10_000;

/** The largest single bet this budget allows right now.
 *
 *  Rounded DOWN off the fraction so the cap can never round up past 5%, then
 *  floored at the table minimum so a subteam that has ground its budget under
 *  100 chips is merely poor rather than locked out — without the floor, 5% of
 *  99 is 4 and there is no legal bet left to place. Never exceeds the balance
 *  itself, so the floor can't overdraw a nearly-empty budget. */
export function maxBet(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const whole = Math.floor(balance);
  return Math.min(whole, Math.max(MIN_BET, Math.floor(whole * BET_FRACTION)));
}

/** Why this stake would be refused, or null if it's good. Mirrors the checks
 *  games.place_bet makes under the row lock, so the UI and the server give the
 *  same answer — but the server's answer is the one that moves money. */
export function betRejection(stake: number, balance: number): string | null {
  if (!Number.isInteger(stake) || stake <= 0) return "Bets are whole chips.";
  const cap = maxBet(balance);
  if (stake > cap) return `One bet can't exceed 5% of the budget (${cap}).`;
  return null;
}
