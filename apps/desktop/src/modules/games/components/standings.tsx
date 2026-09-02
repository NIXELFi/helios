import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchAllTime, fetchBudgetStandings, fetchSubteams, fetchWeekly, isMoney, isRated,
  type GameId, type LeaderboardEntry, type SubteamRanking,
} from "../api";
import { GAMES, categoryOf, gamesInCategory } from "../registry";

/* Shared standings toolkit — one data store + the visual atoms used by both
 * standings layouts (LobbyStandings on the picker screen, GameStandings
 * wrapped around an active game). */

export type Tab = "alltime" | "weekly" | "subteams";

interface BoardData {
  entries: LeaderboardEntry[] | null;
  subteams: SubteamRanking[] | null;
}

/* Module-level stale-while-revalidate board cache. Shared by every hook
 * instance and survives view switches/remounts, so a board fetched once
 * (including by the mount-time prefetch) renders instantly everywhere.
 * `token` records which refreshToken a board was fetched under — a bump
 * (score submitted) makes every board refetch in the background while the
 * old data stays on screen.
 *
 * The cache is keyed by user identity: when the signed-in user changes
 * (sign-out → sign-in) the entire cache is purged so one user's boards are
 * never served to a different user (cross-user data exposure). */
interface CacheEntry { data: BoardData; token: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
let cacheVersion = 0;
const listeners = new Set<() => void>();
let cacheClient: SupabaseClient | null = null;
let cacheUserId: string | null | undefined = undefined; // undefined = never set

function notify() {
  cacheVersion++;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getVersion = () => cacheVersion;

function keyFor(tab: Tab, gameId: GameId): string {
  // The subteams board spans the games of one lobby room (arcade or casino) —
  // one cache slot per room, resolved from the game being viewed.
  return tab === "subteams" ? `subteams:${categoryOf(gameId)}` : `${tab}:${gameId}`;
}

/** Who the client is signed in as, from the LOCAL session — no network.
 *
 *  This used to be `client.auth.getUser()`, which is a round trip to the auth
 *  server on every call, made while holding supabase-auth's global session
 *  lock. Every board refresh fanned out 14 of them, serialised behind that
 *  lock (~1.5–2 s per burst on the work network), and every plinko drop had to
 *  take the same lock to fetch its bearer token — so a burst of drops paid up
 *  to a full auth round trip each, every two seconds, for as long as the
 *  player kept clicking. Reported as "plinko lags when you spam". The cache
 *  key only needs to know WHICH user this is, and the local session says so. */
async function signedInUserId(client: SupabaseClient): Promise<string | null> {
  const { data: { session } } = await client.auth.getSession();
  return session?.user.id ?? null;
}

/** Fetch a board into the cache unless it's already fresh for `token`.
 *  Deduplicates concurrent requests per board. */
async function ensureBoard(
  client: SupabaseClient,
  tab: Tab,
  gameId: GameId,
  token: number,
): Promise<void> {
  // Boards are user-specific: drop the cache when the Supabase client changes
  // OR when the signed-in user changes (sign-out → sign-in on the same client
  // singleton would otherwise serve stale cached boards to the new user).
  const userId = await signedInUserId(client);
  if (cacheClient !== client || cacheUserId !== userId) {
    cacheClient = client;
    cacheUserId = userId;
    cache.clear();
    inflight.clear();
    notify();
  }
  const key = keyFor(tab, gameId);
  const hit = cache.get(key);
  if (hit && hit.token >= token) return Promise.resolve();
  const existing = inflight.get(key);
  if (existing) return existing;
  const load: Promise<BoardData> =
    tab === "subteams"
      ? // The casino runs on one shared pot per subteam, so its standings are
        // simply chips on hand — placement points exist to make incomparable
        // arcade scores comparable, and there is nothing to compare here.
        (categoryOf(gameId) === "casino"
          ? fetchBudgetStandings(client)
          : fetchSubteams(
              client,
              gamesInCategory(categoryOf(gameId)).map((g) => g.id),
            )
        ).then((r) => ({ entries: null, subteams: r }))
      : (tab === "alltime" ? fetchAllTime : fetchWeekly)(client, gameId).then((r) => ({
          entries: r,
          subteams: null,
        }));
  const p = load
    .then((data) => {
      cache.set(key, { data, token });
      notify();
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Warm every board (all-time + weekly per game, plus subteams) so the first
 *  click on any tab/chip is instant. Called when the Games module mounts and
 *  again on every refreshToken bump; errors are swallowed here — a board that
 *  failed to prefetch simply cold-loads (with visible error/retry) when it's
 *  actually viewed. */
export function prefetchBoards(
  client: SupabaseClient,
  token: number,
  /** Refresh only the boards a bet on THIS game can have moved: its own
   *  all-time + weekly ledgers and its room's subteam board. A money cabinet
   *  bumps the token every couple of seconds while it's being played, and
   *  re-pulling all fourteen boards for each bump was most of the traffic
   *  behind "plinko lags when you spam". Omit to warm everything (mount, a
   *  score submitted). */
  only?: GameId,
): void {
  const games = only ? GAMES.filter((g) => g.id === only) : GAMES;
  for (const tab of ["alltime", "weekly"] as const) {
    for (const g of games) {
      void ensureBoard(client, tab, g.id, token).catch(() => {});
    }
  }
  // One subteams board per room — warm each through its first game.
  const rooms = only ? [categoryOf(only)] : (["arcade", "casino"] as const);
  for (const category of rooms) {
    const first = gamesInCategory(category)[0];
    if (first) void ensureBoard(client, "subteams", first.id, token).catch(() => {});
  }
}

/** Standings data source over the shared cache: switching tabs/games shows
 *  the last-known board instantly and refreshes it in the background — the
 *  skeleton only ever appears on a cold (never-fetched) board. */
export function useLeaderboardData(
  client: SupabaseClient,
  tab: Tab,
  gameId: GameId,
  refreshToken: number,
): {
  entries: LeaderboardEntry[] | null;
  subteams: SubteamRanking[] | null;
  /** Cold load — nothing cached for this board yet. Show skeletons. */
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const key = keyFor(tab, gameId);
  useSyncExternalStore(subscribe, getVersion);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let stale = false;
    setError(null);
    ensureBoard(client, tab, gameId, refreshToken).catch((e: unknown) => {
      if (!stale) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, refreshToken, retryToken]);

  const hit = cache.get(key);
  return {
    entries: hit?.data.entries ?? null,
    subteams: hit?.data.subteams ?? null,
    loading: !hit && !error,
    error,
    retry: () => setRetryToken((n) => n + 1),
  };
}

/** What a board is actually showing. A rated game's columns mean something
 *  different from a high-score game's — all-time is the number you're holding
 *  rather than your best ever, weekly is movement rather than a peak, and the
 *  subteam total counts climb above the 1000 everyone starts at — so say so
 *  instead of letting players assume the old meaning. */
export function boardCaption(tab: Tab, gameId: GameId): string {
  const room = categoryOf(gameId) === "casino" ? "CASINO" : "ARCADE";
  if (tab === "subteams") {
    // The casino is one shared pot per subteam — the board is the pot itself,
    // not a sum of anything.
    if (categoryOf(gameId) === "casino") return `${room} · CHIPS ON HAND`;
    // A room can mix rated and scored games; describe what's being summed.
    const games = gamesInCategory(categoryOf(gameId));
    if (games.every((g) => isRated(g.id))) return `${room} · CLIMB ABOVE 1000`;
    if (games.some((g) => isRated(g.id))) return `${room} · BESTS + CLIMB`;
    return `${room} · SUM OF BESTS`;
  }
  // A money game's board is a ledger: chips this player has put into the
  // subteam budget, or taken out of it. Say so — "TOP 10" would read as a high
  // score table and hide that most of these numbers are negative.
  if (isMoney(gameId)) {
    return tab === "weekly" ? "CHIPS WON/LOST · THIS WEEK" : "CHIPS WON/LOST";
  }
  if (!isRated(gameId)) return tab === "weekly" ? "TOP 10 · THIS WEEK" : "TOP 10";
  return tab === "weekly" ? "BIGGEST CLIMB THIS WEEK" : "CURRENT RATING";
}

/** Standard competition ranking ("1224") for an already-total-sorted subteam
 *  list: equal totals share a rank, the next distinct total skips accordingly.
 *  Returned parallel to the input so callers can pass an explicit rank instead
 *  of the array index (which would give tied subteams different medals). */
export function subteamRanks(list: SubteamRanking[]): number[] {
  const ranks: number[] = [];
  let rank = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === 0 || list[i]!.total !== list[i - 1]!.total) rank = i + 1;
    ranks.push(rank);
  }
  return ranks;
}

/** Segmented tab control. `compact` renders the slim Orbitron variant used in
 *  the in-game podium strip. */
export function SegmentedTabs({
  tab,
  onSelect,
  compact = false,
}: {
  tab: Tab;
  onSelect: (t: Tab) => void;
  compact?: boolean;
}) {
  const items = compact
    ? ([["alltime", "ALL"], ["weekly", "WEEK"], ["subteams", "TEAMS"]] as const)
    : ([["alltime", "All-time"], ["weekly", "Weekly"], ["subteams", "Subteams"]] as const);
  return (
    <div className="flex shrink-0 overflow-hidden rounded-sm border border-helios-line">
      {items.map(([id, label], idx) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className={
            (compact
              ? "games-display px-2 py-1 text-[9px] tracking-wider "
              : "px-2.5 py-1 text-[11px] ") +
            "transition-colors " +
            (idx > 0 ? "border-l border-helios-line " : "") +
            (tab === id
              ? "bg-asu-gold font-semibold text-helios-base"
              : "bg-helios-panel text-helios-text hover:bg-helios-line/40")
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Game switcher chips for the lobby board. `muted` (subteams tab — the
 *  board spans all games) keeps the row in place but inert, so the layout
 *  never jumps. */
export function GameChips({
  value,
  onSelect,
  muted = false,
}: {
  value: GameId;
  onSelect: (g: GameId) => void;
  muted?: boolean;
}) {
  return (
    <div
      className={"flex flex-wrap gap-1 transition-opacity " + (muted ? "pointer-events-none opacity-35" : "")}
      aria-hidden={muted || undefined}
    >
      {gamesInCategory(categoryOf(value)).map((g) => {
        const Icon = g.icon;
        const active = value === g.id && !muted;
        return (
          <button
            key={g.id}
            type="button"
            tabIndex={muted ? -1 : undefined}
            onClick={() => onSelect(g.id)}
            className={
              "flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] transition-colors " +
              (active
                ? "border-asu-gold bg-asu-gold/10 text-asu-gold"
                : "border-helios-line bg-helios-panel text-helios-dim hover:border-asu-gold/60 hover:text-helios-text")
            }
          >
            <Icon size={13} strokeWidth={1.5} />
            {g.title}
          </button>
        );
      })}
    </div>
  );
}

/** Podium medal chip for ranks 1–3; plain dim numeral for 4+. */
export function RankChip({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <span
        className={
          "games-num inline-flex w-5 shrink-0 items-center justify-center rounded-sm " +
          "border border-current text-center text-[11px] font-bold leading-5 " +
          `games-rank-${rank}`
        }
      >
        {rank}
      </span>
    );
  }
  return (
    <span className="games-num inline-flex w-5 shrink-0 justify-center text-[11px] text-helios-dim">
      {rank}
    </span>
  );
}

/** One player entry row. */
export function PlayerRow({ entry }: { entry: LeaderboardEntry }) {
  return (
    <li
      className={
        "flex items-center justify-between gap-2 rounded-sm border border-helios-line px-2 py-1 " +
        (entry.rank === 1 ? "bg-asu-gold/[0.05]" : "bg-helios-panel")
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <RankChip rank={entry.rank} />
        <span className="truncate">
          {entry.displayName}
          {entry.subteam && <span className="text-helios-dim"> · {entry.subteam}</span>}
        </span>
      </span>
      <span className="games-num shrink-0 font-semibold text-asu-gold">{entry.best}</span>
    </li>
  );
}

/** One subteam entry row, with the per-game breakdown line. */
export function SubteamRow({ ranking, rank }: { ranking: SubteamRanking; rank: number }) {
  return (
    <li
      className={
        "rounded-sm border border-helios-line px-2 py-1 " +
        (rank === 1 ? "bg-asu-gold/[0.05]" : "bg-helios-panel")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <RankChip rank={rank} />
          <span className="truncate">{ranking.subteam}</span>
        </span>
        <span className="games-num shrink-0 font-semibold text-asu-gold">
          {ranking.total.toLocaleString()}
        </span>
      </div>
      <div className="mt-0.5 pl-[26px] text-[10px] text-helios-dim">
        {ranking.note ??
          GAMES.filter((g) => ranking.perGame[g.id] !== undefined)
          .map((g) => (
            <span key={g.id}>
              {g.title} <span className="games-num">{ranking.perGame[g.id]}</span>
            </span>
          ))
          .reduce((acc: ReactNode[], el, idx) =>
            idx === 0 ? [el] : [...acc, <span key={`sep-${idx}`}> · </span>, el], [])}
      </div>
    </li>
  );
}

/** Pulsing placeholder bars, sized to match real rows (no layout shift). */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="h-[30px] animate-pulse rounded-sm border border-helios-line bg-helios-panel"
        />
      ))}
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-1 py-6 text-center">
      <div className="games-display text-base text-helios-line">—</div>
      <div className="text-xs text-helios-dim">No scores yet. Be the first.</div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1.5 text-xs text-red-300">
      {message}{" "}
      <button type="button" className="underline" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
