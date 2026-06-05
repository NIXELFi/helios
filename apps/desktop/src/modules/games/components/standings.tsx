import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchAllTime, fetchSubteams, fetchWeekly,
  type GameId, type LeaderboardEntry, type SubteamRanking,
} from "../api";
import { GAMES } from "../registry";

/* Shared standings toolkit — one data hook + the visual atoms used by both
 * standings layouts (LobbyStandings on the picker screen, GameStandings
 * wrapped around an active game). */

export type Tab = "alltime" | "weekly" | "subteams";

interface BoardData {
  entries: LeaderboardEntry[] | null;
  subteams: SubteamRanking[] | null;
}

/** Standings data source with a stale-while-revalidate cache: switching
 *  tabs/games shows the last-known board instantly and refreshes it in the
 *  background — the skeleton only ever appears on a cold (never-fetched)
 *  board, so the UI never flashes empty on a tab switch. */
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
  // The subteams board spans all games, so it gets one cache slot.
  const key = tab === "subteams" ? "subteams" : `${tab}:${gameId}`;
  const cacheRef = useRef(new Map<string, BoardData>());
  const [, bump] = useState(0); // re-render after a background refresh lands
  const [loadingKey, setLoadingKey] = useState<string | null>(key);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let stale = false;
    setError(null);
    setLoadingKey(key);
    const store = (data: BoardData) => {
      if (stale) return;
      cacheRef.current.set(key, data);
      setLoadingKey(null);
      bump((n) => n + 1);
    };
    const load =
      tab === "subteams"
        ? fetchSubteams(client).then((r) => store({ entries: null, subteams: r }))
        : (tab === "alltime" ? fetchAllTime : fetchWeekly)(client, gameId).then((r) =>
            store({ entries: r, subteams: null }),
          );
    load.catch((e: unknown) => {
      if (!stale) {
        setLoadingKey(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tab, gameId, refreshToken, retryToken]);

  const cached = cacheRef.current.get(key);
  return {
    entries: cached?.entries ?? null,
    subteams: cached?.subteams ?? null,
    loading: loadingKey === key && !cached,
    error,
    retry: () => setRetryToken((n) => n + 1),
  };
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
      {GAMES.map((g) => {
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
        <span className="games-num shrink-0 font-semibold text-asu-gold">{ranking.total}</span>
      </div>
      <div className="mt-0.5 pl-[26px] text-[10px] text-helios-dim">
        {GAMES.filter((g) => ranking.perGame[g.id] !== undefined)
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
