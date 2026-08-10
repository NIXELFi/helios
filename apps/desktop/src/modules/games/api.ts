import type { SupabaseClient } from "@helios/auth";

// Data layer for the Games module. Reads/writes the `games` Postgres schema;
// RLS + a BEFORE INSERT trigger own identity, so the client only ever sends
// (game_id, score). Same unwrap convention as modules/pm/lib/data.ts.

export type GameId = "snake" | "breakout" | "flappy" | "2048" | "blackjack";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  subteam: string | null;
  best: number;
  rank: number;
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
  view: "leaderboard_alltime" | "leaderboard_weekly",
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

export const fetchAllTime = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(client, "leaderboard_alltime", gameId);

export const fetchWeekly = (client: SupabaseClient, gameId: GameId) =>
  fetchBoard(client, "leaderboard_weekly", gameId);

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

export async function fetchSubteams(
  client: SupabaseClient,
  gameIds: readonly GameId[],
): Promise<SubteamRanking[]> {
  const rows = unwrap<{ subteam: string; game_id: GameId; subtotal: number }[]>(
    await client
      .schema("games")
      .from("leaderboard_subteams")
      .select("subteam,game_id,subtotal")
      .limit(200),
    "subteam ranking",
  );
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
