import type { SupabaseClient } from "@helios/auth";

// Data layer for the Games module. Reads/writes the `games` Postgres schema;
// RLS + a BEFORE INSERT trigger own identity, so the client only ever sends
// (game_id, score). Same unwrap convention as modules/pm/lib/data.ts.

export type GameId = "snake" | "breakout" | "flappy" | "2048" | "blackjack" | "plinko";

/** Games scored by a PERSISTENT rating rather than a high score. These read
 *  and write games.ratings instead of games.scores: their board shows the
 *  number a player is currently holding, so it can go down, and quitting on a
 *  hot streak banks nothing. */
// Empty today: blackjack was the only rated cabinet and it now plays purely for
// the subteam's money. The ratings table, its RPCs and the whole leaderboard
// path below are deliberately LEFT IN PLACE — nobody's history is deleted, and
// putting a game back on the ladder is a one-line change here.
const RATED_GAMES: ReadonlySet<GameId> = new Set<GameId>([]);

export function isRated(gameId: GameId): boolean {
  return RATED_GAMES.has(gameId);
}

/** Games that spend the SUBTEAM'S SHARED BUDGET. These have no score and no
 *  rating: what they leave behind is a row in games.bets and a changed balance,
 *  so their boards are ledgers (and can be negative, which is the point).
 *  Blackjack joins this set when it moves onto the shared budget. */
const MONEY_GAMES: ReadonlySet<GameId> = new Set<GameId>(["plinko", "blackjack"]);

export function isMoney(gameId: GameId): boolean {
  return MONEY_GAMES.has(gameId);
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  subteam: string | null;
  best: number;
  rank: number;
}

/** A player's carried rating for a rated game. */
export interface Rating {
  rating: number;
  handsRated: number;
}

/** What the server made of a submitted session. */
export interface AppliedSession extends Rating {
  delta: number;
}

export interface SubteamRanking {
  subteam: string;
  total: number;
  perGame: Partial<Record<GameId, number>>;
  /** Sub-line shown under the row when there is no per-game breakdown to show
   *  — the casino board is one shared pot, so it explains the pot instead. */
  note?: string;
}

function unwrap<T>(
  res: { data: unknown; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? []) as T;
}

export async function submitScore(
  client: SupabaseClient,
  gameId: GameId,
  score: number,
  /** Caller-supplied idempotency nonce: same nonce → same logical submission.
   *  Pass the same value on retry so a network hiccup that already inserted
   *  the row doesn't produce a duplicate.  Defaults to a fresh uuid when
   *  omitted (i.e. each call with no nonce is always a new submission). */
  nonce?: string,
): Promise<void> {
  if (!Number.isInteger(score) || score < 0) {
    throw new Error(`invalid score: ${score}`);
  }
  const table = client.schema("games").from("scores");
  // With a nonce, upsert against the (user_id, game_id, submission_nonce) unique
  // index so a retry that already committed the row is a no-op instead of a
  // duplicate row (or a 409). Without one, fall back to a plain insert.
  const res =
    nonce !== undefined
      ? await table.upsert(
          { game_id: gameId, score, submission_nonce: nonce },
          { onConflict: "user_id,game_id,submission_nonce", ignoreDuplicates: true },
        )
      : await table.insert({ game_id: gameId, score });
  if (res.error) throw new Error(`submit score: ${res.error.message}`);
}

// ------------------------------------------------------------ rated games
// The client never computes the stored rating. It reports what it measured
// about the session — hands played and the advantage they were worth — and
// games.apply_rated_session_v3 does the arithmetic under a row lock. That
// keeps the read-modify-write atomic across windows and keeps the ladder
// honest. The _v3 suffix is the money-scale formula (skill money, √ ladder):
// the unsuffixed RPC still exists as a harmless no-op so clients from before
// the 2026-08 ladder reset can't write old-scale sessions onto the new board.

/** The rating this player is carrying, or a fresh 1000 if they've never
 *  played. Called before a rated cabinet mounts. */
export async function fetchRating(
  client: SupabaseClient,
  gameId: GameId,
): Promise<Rating> {
  const res = await client
    .schema("games")
    .from("ratings")
    .select("rating,hands_rated")
    .eq("game_id", gameId)
    .maybeSingle();
  if (res.error) throw new Error(`fetch rating: ${res.error.message}`);
  const row = res.data as { rating: number; hands_rated: number } | null;
  // No row yet is the normal first-play case, not an error.
  return row
    ? { rating: Number(row.rating), handsRated: Number(row.hands_rated) }
    : { rating: 1000, handsRated: 0 };
}

/** Fold a finished session into the carried rating. `nonce` makes this
 *  exactly-once: replaying it returns the original result rather than
 *  applying the session twice. */
export async function submitRatedSession(
  client: SupabaseClient,
  gameId: GameId,
  session: { hands: number; totalAdvantage: number },
  nonce: string,
): Promise<AppliedSession> {
  if (!Number.isFinite(session.totalAdvantage) || !Number.isInteger(session.hands)) {
    throw new Error(`invalid session: ${JSON.stringify(session)}`);
  }
  const res = await client.schema("games").rpc("apply_rated_session_v3", {
    p_game_id: gameId,
    p_hands: session.hands,
    p_advantage: session.totalAdvantage,
    p_nonce: nonce,
  });
  if (res.error) throw new Error(`submit session: ${res.error.message}`);
  // RETURNS TABLE arrives as a one-row array.
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | { new_rating: number; applied_delta: number; total_hands: number }
    | undefined;
  if (!row) throw new Error("submit session: no result");
  return {
    rating: Number(row.new_rating),
    delta: Number(row.applied_delta),
    handsRated: Number(row.total_hands),
  };
}

interface BoardRow {
  user_id: string;
  display_name: string | null;
  subteam: string | null;
  best: number;
}

function toEntries(rows: BoardRow[]): LeaderboardEntry[] {
  const sorted = [...rows].sort((a, b) => Number(b.best) - Number(a.best));
  // Standard competition ranking ("1224"): equal scores share the better rank;
  // the next distinct score skips the positions consumed by the tied group.
  let rank = 0;
  return sorted.map((r, i) => {
    if (i === 0 || Number(sorted[i]!.best) !== Number(sorted[i - 1]!.best)) {
      rank = i + 1;
    }
    return {
      userId: r.user_id,
      displayName: r.display_name ?? "Unknown",
      subteam: r.subteam,
      best: Number(r.best),
      rank,
    };
  });
}

async function fetchBoard(
  client: SupabaseClient,
  view: string,
  gameId: GameId,
): Promise<LeaderboardEntry[]> {
  const rows = unwrap<BoardRow[]>(
    await client
      .schema("games")
      .from(view)
      .select("user_id,display_name,subteam,best")
      .eq("game_id", gameId)
      .order("best", { ascending: false })
      .limit(50),
    view,
  );
  return toEntries(rows);
}

/** All-time. For a rated game this is the rating each player is holding right
 *  now — not their best ever, which is the whole point of a rating. For a money
 *  game it's the chips that player has put into (or taken out of) the subteam
 *  budget, which is a ledger and is frequently negative. */
export const fetchAllTime = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(
    client,
    // Money wins over rating: chips are the casino scoreboard now, and the
    // rating has become a personal number shown inside the cabinet.
    isMoney(gameId) ? "leaderboard_money_alltime"
    : isRated(gameId) ? "leaderboard_ratings"
    : "leaderboard_alltime",
    gameId,
  );

/** Weekly. "Best this week" is meaningless for a number you carry, so a rated
 *  game's weekly board is how far you MOVED it this week — a race that resets,
 *  and one a newcomer can win. Values can be negative. */
export const fetchWeekly = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(
    client,
    isMoney(gameId) ? "leaderboard_money_weekly"
    : isRated(gameId) ? "leaderboard_ratings_weekly"
    : "leaderboard_weekly",
    gameId,
  );

// Grand Prix subteam scoring. Raw scores aren't comparable across games — a 2048
// best runs into the thousands while a Flappy best is in the tens — so summing
// the raw per-game subtotals let 2048 swamp every other game and decide the
// subteam standings on its own. Instead each game is scored like a race: within
// a game the subteams are RANKED by their subtotal and earn placement POINTS,
// which ARE comparable across games. A subteam's total is the sum of its
// placement points over every game it placed in, so each game counts equally.
//
// Each lobby room runs its own Grand Prix: callers pass the room's game list
// (registry gamesInCategory) and rows outside it are dropped, so the casino
// never scores points on the arcade board or vice versa.
const PLACEMENT_POINTS = [10, 8, 6, 5, 4, 3, 2, 1] as const;

interface SubteamRow {
  subteam: string;
  game_id: GameId;
  subtotal: number;
}

export async function fetchSubteams(
  client: SupabaseClient,
  gameIds: readonly GameId[],
): Promise<SubteamRanking[]> {
  // Score games and rated games keep separate subteam views, so a room fetches
  // whichever it actually needs (both, once a room mixes the two). Rated
  // subtotals count how far members have climbed ABOVE the 1000 everyone
  // starts at — summing raw ratings would just rank subteams by headcount.
  const wantScores = gameIds.some((g) => !isRated(g));
  const wantRatings = gameIds.some((g) => isRated(g));
  const read = (view: string) =>
    client.schema("games").from(view).select("subteam,game_id,subtotal").limit(200);
  const [scoreRows, ratingRows] = await Promise.all([
    wantScores
      ? read("leaderboard_subteams").then((r) => unwrap<SubteamRow[]>(r, "subteam ranking"))
      : Promise.resolve([] as SubteamRow[]),
    wantRatings
      ? read("leaderboard_ratings_subteams").then((r) =>
          unwrap<SubteamRow[]>(r, "rated subteam ranking"),
        )
      : Promise.resolve([] as SubteamRow[]),
  ]);
  const rows = [...scoreRows, ...ratingRows];
  // Group each in-room game's subteam subtotals so we can rank within the game.
  const games = new Map<GameId, { subteam: string; subtotal: number }[]>();
  for (const r of rows) {
    if (!gameIds.includes(r.game_id)) continue;
    const list = games.get(r.game_id) ?? [];
    list.push({ subteam: r.subteam, subtotal: Number(r.subtotal) });
    games.set(r.game_id, list);
  }
  const by = new Map<string, SubteamRanking>();
  for (const [gameId, list] of games) {
    // Rank by subtotal, highest first. Ties share the better placement's points
    // (standard competition ranking), so two equal subteams get the same award.
    const sorted = [...list].sort((a, b) => b.subtotal - a.subtotal);
    let place = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i]!.subtotal < sorted[i - 1]!.subtotal) place = i;
      const points = PLACEMENT_POINTS[place] ?? 0;
      const name = sorted[i]!.subteam;
      const entry = by.get(name) ?? { subteam: name, total: 0, perGame: {} };
      entry.perGame[gameId] = points;
      entry.total += points;
      by.set(name, entry);
    }
  }
  // Highest total first; deterministic name tiebreak so equal totals are stable.
  return [...by.values()].sort(
    (a, b) => b.total - a.total || a.subteam.localeCompare(b.subteam),
  );
}

// ------------------------------------------------------- shared subteam money
// The casino spends ONE budget per subteam. The client never computes a
// balance: it asks the server what the budget holds, asks the server to place
// a bet, and renders whatever comes back. games.plinko_drop does the cap check,
// the roll, the payout and the ledger write in a single locked transaction, so
// two members playing at once can't both spend the same chips.

export interface Budget {
  subteam: string;
  balance: number;
  /** Largest legal single bet right now: 5% of the balance, floored at the
   *  table minimum. Recomputed server-side on every drop — treat the value
   *  returned by dropBall as authoritative over this one. */
  maxBet: number;
}

/** The caller's subteam budget, created at the starting balance if this is the
 *  subteam's first visit. */
export async function fetchBudget(client: SupabaseClient): Promise<Budget> {
  const res = await client.schema("games").rpc("my_budget");
  if (res.error) throw new Error(`fetch budget: ${res.error.message}`);
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | { budget_subteam: string; budget_balance: number; budget_max_bet: number }
    | undefined;
  if (!row) throw new Error("fetch budget: no result");
  return {
    subteam: row.budget_subteam,
    balance: Number(row.budget_balance),
    maxBet: Number(row.budget_max_bet),
  };
}

export interface DropRequest {
  rows: number;
  risk: string;
  stake: number;
}

export interface DropResult {
  /** One L/R per row — the ball the SERVER dropped. The cabinet animates this;
   *  it does not get a vote in where the ball lands. */
  path: string;
  bucket: number;
  multiplierCents: number;
  payout: number;
  /** payout − stake. Negative on a losing drop, which is most of them. */
  net: number;
  balance: number;
  maxBet: number;
  /** True when this nonce had already been played and the server replayed the
   *  original result rather than rolling again. */
  replay: boolean;
}

/** Drop one ball. `nonce` makes this exactly-once: a retry after a dropped
 *  connection replays the original ball instead of rolling a second one and
 *  charging for it twice. */
export async function dropBall(
  client: SupabaseClient,
  req: DropRequest,
  nonce: string,
): Promise<DropResult> {
  if (!Number.isInteger(req.stake) || req.stake <= 0) {
    throw new Error(`stake must be whole chips: ${req.stake}`);
  }
  if (!nonce) throw new Error("nonce required");
  const res = await client.schema("games").rpc("plinko_drop", {
    p_rows: req.rows,
    p_risk: req.risk,
    p_stake: req.stake,
    p_nonce: nonce,
  });
  if (res.error) throw new Error(res.error.message);
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | {
        drop_path: string; drop_bucket: number; drop_multiplier: number;
        drop_payout: number; drop_net: number; new_balance: number;
        new_max_bet: number; was_replay: boolean;
      }
    | undefined;
  if (!row) throw new Error("drop: no result");
  return {
    path: row.drop_path,
    bucket: Number(row.drop_bucket),
    multiplierCents: Number(row.drop_multiplier),
    payout: Number(row.drop_payout),
    net: Number(row.drop_net),
    balance: Number(row.new_balance),
    maxBet: Number(row.new_max_bet),
    replay: Boolean(row.was_replay),
  };
}

export interface BudgetStanding {
  subteam: string;
  balance: number;
  staked: number;
  returned: number;
  bets: number;
  rank: number;
}

/** Casino standings: chips on hand, per subteam. Unlike the arcade there is
 *  nothing to normalise across games — every casino game spends the same pot,
 *  so the pot IS the score. */
export async function fetchBudgets(client: SupabaseClient): Promise<BudgetStanding[]> {
  const rows = unwrap<
    { subteam: string; balance: number; staked: number; returned: number; bets: number }[]
  >(
    await client
      .schema("games")
      .from("leaderboard_budgets")
      .select("subteam,balance,staked,returned,bets")
      .order("balance", { ascending: false })
      .limit(50),
    "budget standings",
  );
  const sorted = [...rows].sort((a, b) => Number(b.balance) - Number(a.balance));
  let rank = 0;
  return sorted.map((r, i) => {
    if (i === 0 || Number(sorted[i]!.balance) !== Number(sorted[i - 1]!.balance)) {
      rank = i + 1;
    }
    return {
      subteam: r.subteam,
      balance: Number(r.balance),
      staked: Number(r.staked),
      returned: Number(r.returned),
      bets: Number(r.bets),
      rank,
    };
  });
}

export interface LedgerEntry {
  id: string;
  subteam: string;
  userId: string;
  displayName: string;
  gameId: GameId;
  stake: number;
  payout: number;
  net: number;
  balanceAfter: number;
  /** Plinko only: what the ball did. Null for games without one. */
  multiplierCents: number | null;
  bucket: number | null;
  createdAt: string;
}

/** The casino's recent activity: who spent what, and how it went. This is the
 *  display that makes shared money legible — every member can see where the
 *  budget went without having to ask. */
export async function fetchLedger(
  client: SupabaseClient,
  limit = 30,
): Promise<LedgerEntry[]> {
  const rows = unwrap<
    {
      id: string; subteam: string; user_id: string; display_name: string | null;
      game_id: GameId; stake: number; payout: number; net: number;
      balance_after: number; detail: Record<string, unknown> | null; created_at: string;
    }[]
  >(
    await client
      .schema("games")
      .from("ledger_recent")
      .select("id,subteam,user_id,display_name,game_id,stake,payout,net,balance_after,detail,created_at")
      .limit(limit),
    "ledger",
  );
  return rows.map((r) => ({
    id: r.id,
    subteam: r.subteam,
    userId: r.user_id,
    displayName: r.display_name ?? "Unknown",
    gameId: r.game_id,
    stake: Number(r.stake),
    payout: Number(r.payout),
    net: Number(r.net),
    balanceAfter: Number(r.balance_after),
    multiplierCents:
      r.detail && typeof r.detail.multiplier_cents === "number" ? r.detail.multiplier_cents : null,
    bucket: r.detail && typeof r.detail.bucket === "number" ? r.detail.bucket : null,
    createdAt: r.created_at,
  }));
}

/** Casino standings, shaped like the arcade's so the same board renders them.
 *
 *  The arcade normalises across games with placement points because a 2048
 *  best and a Snake best aren't comparable quantities. The casino has no such
 *  problem: every casino game spends the same pot, so the pot IS the score and
 *  the total is simply chips on hand. */
export async function fetchBudgetStandings(
  client: SupabaseClient,
): Promise<SubteamRanking[]> {
  const budgets = await fetchBudgets(client);
  return budgets.map((b) => ({
    subteam: b.subteam,
    total: b.balance,
    perGame: {},
    note:
      b.bets === 0
        ? "untouched"
        : `${b.staked.toLocaleString()} staked · ${b.bets.toLocaleString()} bets`,
  }));
}

// ------------------------------------------------- two-phase bets (blackjack)
// A blackjack hand is played over many seconds and several decisions, so it
// can't settle atomically the way a plinko drop does. The chips leave the
// budget when the cards come out and return when the hand finishes — which is
// also where they really are in between: on the table.
//
// Every call carries its own nonce and is idempotent, because every one of
// them moves money and all three can be interrupted by a flaky network.

export interface PlacedBet {
  betId: string;
  balance: number;
  maxBet: number;
  replay: boolean;
}

export interface RaisedBet {
  /** Total on the hand after doubling — twice what was placed. */
  stake: number;
  balance: number;
  maxBet: number;
  replay: boolean;
}

export interface SettledBet {
  payout: number;
  net: number;
  balance: number;
  maxBet: number;
  replay: boolean;
}

function firstRow<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(res.error.message);
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as T | undefined;
  if (!row) throw new Error(`${what}: no result`);
  return row;
}

/** Take the stake for a hand about to be dealt. Rejects if the subteam can't
 *  cover it, or if this player already has a hand open. */
export async function placeBet(
  client: SupabaseClient,
  gameId: GameId,
  stake: number,
  nonce: string,
): Promise<PlacedBet> {
  if (!Number.isInteger(stake) || stake <= 0) {
    throw new Error(`stake must be whole chips: ${stake}`);
  }
  if (!nonce) throw new Error("nonce required");
  const row = firstRow<{
    bet_id: string; new_balance: number; new_max_bet: number; was_replay: boolean;
  }>(
    await client.schema("games").rpc("place_bet", {
      p_game_id: gameId, p_stake: stake, p_nonce: nonce,
    }),
    "place bet",
  );
  return {
    betId: row.bet_id,
    balance: Number(row.new_balance),
    maxBet: Number(row.new_max_bet),
    replay: Boolean(row.was_replay),
  };
}

/** Double down: a second stake of the same size, capped on its own, so a
 *  doubled hand can carry up to 10% of the budget. */
export async function raiseBet(
  client: SupabaseClient,
  betId: string,
  nonce: string,
): Promise<RaisedBet> {
  if (!nonce) throw new Error("nonce required");
  const row = firstRow<{
    new_stake: number; new_balance: number; new_max_bet: number; was_replay: boolean;
  }>(
    await client.schema("games").rpc("raise_bet", { p_bet_id: betId, p_nonce: nonce }),
    "raise bet",
  );
  return {
    stake: Number(row.new_stake),
    balance: Number(row.new_balance),
    maxBet: Number(row.new_max_bet),
    replay: Boolean(row.was_replay),
  };
}

/** Pay a finished hand. The server can't know whether the hand was really won
 *  — the shoe is dealt client-side — but it does refuse any payout no legal
 *  blackjack hand could produce, and every settle lands in a ledger the whole
 *  subteam can read. */
export async function settleBet(
  client: SupabaseClient,
  betId: string,
  payout: number,
  outcome: string,
  nonce: string,
): Promise<SettledBet> {
  if (!Number.isInteger(payout) || payout < 0) {
    throw new Error(`payout must be whole chips: ${payout}`);
  }
  if (!nonce) throw new Error("nonce required");
  const row = firstRow<{
    settled_payout: number; settled_net: number; new_balance: number;
    new_max_bet: number; was_replay: boolean;
  }>(
    await client.schema("games").rpc("settle_bet", {
      p_bet_id: betId, p_payout: payout, p_outcome: outcome, p_nonce: nonce,
    }),
    "settle bet",
  );
  return {
    payout: Number(row.settled_payout),
    net: Number(row.settled_net),
    balance: Number(row.new_balance),
    maxBet: Number(row.new_max_bet),
    replay: Boolean(row.was_replay),
  };
}

/** Close out a hand abandoned by a previous session. The stake is FORFEIT, not
 *  refunded: the client knows the outcome before it settles, so refunding an
 *  abandoned hand would pay players to close the window on losing ones.
 *  Resolves to null when there was nothing open. */
export async function forfeitOpenBet(
  client: SupabaseClient,
  gameId: GameId,
): Promise<{ betId: string; stake: number } | null> {
  const res = await client.schema("games").rpc("forfeit_open_bet", { p_game_id: gameId });
  if (res.error) throw new Error(`forfeit: ${res.error.message}`);
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | { forfeited_id: string; forfeited_stake: number }
    | undefined;
  return row ? { betId: row.forfeited_id, stake: Number(row.forfeited_stake) } : null;
}
