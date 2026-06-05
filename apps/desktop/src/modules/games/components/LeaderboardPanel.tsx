import { useEffect, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchAllTime, fetchSubteams, fetchWeekly,
  type GameId, type LeaderboardEntry, type SubteamRanking,
} from "../api";
import { GAMES } from "../registry";

export type Tab = "alltime" | "weekly" | "subteams";

interface Props {
  client: SupabaseClient;
  gameId: GameId;
  /** Bump to force a refetch (after a successful score submit). */
  refreshToken: number;
}

/** Shared standings data source — used by the side tower (picker view) and
 *  the split strips around an active game (GameStandings). One fetch per
 *  (tab, game, refresh); stale-guarded. */
export function useLeaderboardData(
  client: SupabaseClient,
  tab: Tab,
  gameId: GameId,
  refreshToken: number,
): {
  entries: LeaderboardEntry[] | null;
  subteams: SubteamRanking[] | null;
  error: string | null;
  retry: () => void;
} {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [subteams, setSubteams] = useState<SubteamRanking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let stale = false;
    setError(null);
    setEntries(null);
    setSubteams(null);
    const load =
      tab === "subteams"
        ? fetchSubteams(client).then((r) => { if (!stale) setSubteams(r); })
        : (tab === "alltime" ? fetchAllTime : fetchWeekly)(client, gameId).then((r) => {
            if (!stale) setEntries(r);
          });
    load.catch((e: unknown) => {
      if (!stale) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { stale = true; };
  }, [client, tab, gameId, refreshToken, retryToken]);

  return { entries, subteams, error, retry: () => setRetryToken((n) => n + 1) };
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
              : "flex-1 px-2 py-1 text-[11px] ") +
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

export function LeaderboardPanel({ client, gameId, refreshToken }: Props) {
  const [tab, setTab] = useState<Tab>("alltime");
  const { entries, subteams, error, retry } = useLeaderboardData(client, tab, gameId, refreshToken);

  const gameTitle = GAMES.find((g) => g.id === gameId)?.title ?? gameId;

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2 border-l border-helios-line bg-gradient-to-b from-helios-panel/40 to-helios-base p-3">
      {/* Timing-tower header */}
      <div className="games-display text-[10px] tracking-[0.2em] text-helios-dim">
        STANDINGS
      </div>
      <div className="games-hazard h-[3px] w-full rounded-full opacity-70" />

      {/* Segmented tab control */}
      <SegmentedTabs tab={tab} onSelect={setTab} />

      <div className="text-[10px] uppercase tracking-wider text-helios-dim">
        {tab === "subteams" ? "All games · sum of bests" : gameTitle}
      </div>

      {error ? (
        <div className="text-xs text-red-300">
          {error}{" "}
          <button type="button" className="underline" onClick={retry}>
            Retry
          </button>
        </div>
      ) : tab === "subteams" ? (
        subteams === null ? (
          <SkeletonRows />
        ) : subteams.length === 0 ? (
          <EmptyState />
        ) : (
          <ol className="flex flex-col gap-1 overflow-y-auto text-xs text-helios-text">
            {subteams.map((s, i) => (
              <li
                key={s.subteam}
                className={
                  "rounded-sm border border-helios-line px-2 py-1 " +
                  (i === 0 ? "bg-asu-gold/[0.05]" : "bg-helios-panel")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <RankChip rank={i + 1} />
                    <span className="truncate">{s.subteam}</span>
                  </span>
                  <span className="games-num shrink-0 font-semibold text-asu-gold">{s.total}</span>
                </div>
                <div className="mt-0.5 pl-[26px] text-[10px] text-helios-dim">
                  {GAMES.filter((g) => s.perGame[g.id] !== undefined)
                    .map((g) => (
                      <span key={g.id}>
                        {g.title} <span className="games-num">{s.perGame[g.id]}</span>
                      </span>
                    ))
                    .reduce((acc: ReactNode[], el, idx) =>
                      idx === 0 ? [el] : [...acc, <span key={`sep-${idx}`}> · </span>, el], [])}
                </div>
              </li>
            ))}
          </ol>
        )
      ) : entries === null ? (
        <SkeletonRows />
      ) : entries.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="flex flex-col gap-1 overflow-y-auto text-xs text-helios-text">
          {entries.map((e) => (
            <li
              key={e.userId}
              className={
                "flex items-center justify-between gap-2 rounded-sm border border-helios-line px-2 py-1 " +
                (e.rank === 1 ? "bg-asu-gold/[0.05]" : "bg-helios-panel")
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <RankChip rank={e.rank} />
                <span className="truncate">
                  {e.displayName}
                  {e.subteam && <span className="text-helios-dim"> · {e.subteam}</span>}
                </span>
              </span>
              <span className="games-num shrink-0 font-semibold text-asu-gold">{e.best}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

/** Three pulsing placeholder bars, sized to match real rows (no layout shift). */
export function SkeletonRows() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
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
