import type { SupabaseClient } from "@helios/auth";

// Data layer for the Games module. Reads/writes the `games` Postgres schema;
// RLS + a BEFORE INSERT trigger own identity, so the client only ever sends
// (game_id, score). Same unwrap convention as modules/pm/lib/data.ts.

export type GameId = "snake" | "breakout" | "flappy" | "2048";

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
): Promise<void> {
  if (!Number.isInteger(score) || score < 0) {
    throw new Error(`invalid score: ${score}`);
  }
  const res = await client.schema("games").from("scores").insert({ game_id: gameId, score });
  if (res.error) throw new Error(`submit score: ${res.error.message}`);
}

interface BoardRow {
  user_id: string;
  display_name: string | null;
  subteam: string | null;
  best: number;
}

function toEntries(rows: BoardRow[]): LeaderboardEntry[] {
  return [...rows]
    .sort((a, b) => Number(b.best) - Number(a.best))
    .map((r, i) => ({
      userId: r.user_id,
      displayName: r.display_name ?? "Unknown",
      subteam: r.subteam,
      best: Number(r.best),
      rank: i + 1,
    }));
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

export async function fetchSubteams(client: SupabaseClient): Promise<SubteamRanking[]> {
  const rows = unwrap<{ subteam: string; game_id: GameId; subtotal: number }[]>(
    await client
      .schema("games")
      .from("leaderboard_subteams")
      .select("subteam,game_id,subtotal")
      .limit(200),
    "subteam ranking",
  );
  const by = new Map<string, SubteamRanking>();
  for (const r of rows) {
    const entry = by.get(r.subteam) ?? { subteam: r.subteam, total: 0, perGame: {} };
    entry.total += Number(r.subtotal);
    entry.perGame[r.game_id] = Number(r.subtotal);
    by.set(r.subteam, entry);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}
