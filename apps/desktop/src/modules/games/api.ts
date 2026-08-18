import type { SupabaseClient } from "@helios/auth";

// Data layer for the Games module. Reads/writes the `games` Postgres schema;
// RLS + a BEFORE INSERT trigger own identity, so the client only ever sends
// (game_id, score). Same unwrap convention as modules/pm/lib/data.ts.

export type GameId = "snake" | "breakout" | "flappy" | "2048" | "blackjack";

/** Games scored by a PERSISTENT rating rather than a high score. These read
 *  and write games.ratings instead of games.scores: their board shows the
 *  number a player is currently holding, so it can go down, and quitting on a
 *  hot streak banks nothing. */
const RATED_GAMES: ReadonlySet<GameId> = new Set<GameId>(["blackjack"]);

export function isRated(gameId: GameId): boolean {
  return RATED_GAMES.has(gameId);
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
 *  now — not their best ever, which is the whole point of a rating. */
export const fetchAllTime = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(client, isRated(gameId) ? "leaderboard_ratings" : "leaderboard_alltime", gameId);

/** Weekly. "Best this week" is meaningless for a number you carry, so a rated
 *  game's weekly board is how far you MOVED it this week — a race that resets,
 *  and one a newcomer can win. Values can be negative. */
export const fetchWeekly = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(client, isRated(gameId) ? "leaderboard_ratings_weekly" : "leaderboard_weekly", gameId);

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
