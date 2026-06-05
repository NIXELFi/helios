import { useState, type ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";
import type { GameId } from "../api";
import { GAMES } from "../registry";
import {
  EmptyState,
  RankChip,
  SegmentedTabs,
  useLeaderboardData,
  type Tab,
} from "./LeaderboardPanel";

/* In-game standings layout: instead of a side tower stealing horizontal room,
 * the board wraps the game vertically — a slim podium strip (top 3 of the
 * selected board) above the surface, and the rest of the field in a compact
 * grid below. One shared fetch feeds both halves. */

interface Props {
  client: SupabaseClient;
  gameId: GameId;
  /** Bump to force a refetch (after a successful score submit). */
  refreshToken: number;
  /** The game surface (bezel + canvas + overlay). */
  children: ReactNode;
}

interface PodiumRow {
  key: string;
  rank: number;
  label: string;
  sub?: string | null;
  value: number;
}

export function GameStandings({ client, gameId, refreshToken, children }: Props) {
  const [tab, setTab] = useState<Tab>("alltime");
  const { entries, subteams, error, retry } = useLeaderboardData(client, tab, gameId, refreshToken);

  const isTeams = tab === "subteams";
  const loading = !error && (isTeams ? subteams === null : entries === null);

  const podium: PodiumRow[] = isTeams
    ? (subteams ?? []).slice(0, 3).map((s, i) => ({
        key: s.subteam, rank: i + 1, label: s.subteam, value: s.total,
      }))
    : (entries ?? []).slice(0, 3).map((e) => ({
        key: e.userId, rank: e.rank, label: e.displayName, sub: e.subteam, value: e.best,
      }));
  const restPlayers = isTeams ? [] : (entries ?? []).slice(3);
  const restSubteams = isTeams ? (subteams ?? []).slice(3) : [];
  const hasRest = restPlayers.length > 0 || restSubteams.length > 0;

  return (
    <div className="flex min-h-0 w-fit max-w-full flex-col items-stretch gap-2">
      {/* ── podium strip ─────────────────────────────────────────────── */}
      <div className="flex w-full shrink-0 items-center gap-3 rounded-sm border border-helios-line bg-helios-panel/70 px-2.5 py-1.5">
        <div className="flex shrink-0 flex-col gap-1">
          <span className="games-display text-[9px] tracking-[0.2em] text-helios-dim">
            STANDINGS
          </span>
          <span className="games-hazard h-[2px] w-full rounded-full opacity-70" />
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden">
          {error ? (
            <span className="games-display text-[10px] text-helios-line">—</span>
          ) : loading ? (
            <span className="flex gap-4" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-4 w-20 animate-pulse rounded-sm bg-helios-line/40" />
              ))}
            </span>
          ) : podium.length === 0 ? (
            <span className="text-[11px] text-helios-dim">No scores yet. Be the first.</span>
          ) : (
            podium.map((r) => (
              <span key={r.key} className="flex min-w-0 items-center gap-1.5 text-xs text-helios-text">
                <RankChip rank={r.rank} />
                <span className="max-w-[8.5rem] truncate" title={r.sub ?? undefined}>
                  {r.label}
                </span>
                <span className="games-num shrink-0 font-semibold text-asu-gold">{r.value}</span>
              </span>
            ))
          )}
        </div>

        <SegmentedTabs tab={tab} onSelect={setTab} compact />
      </div>

      {/* ── the game ─────────────────────────────────────────────────── */}
      {children}

      {/* ── rest of the field ────────────────────────────────────────── */}
      <div className="min-h-0 w-full shrink overflow-y-auto">
        {error ? (
          <div className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1.5 text-xs text-red-300">
            {error}{" "}
            <button type="button" className="underline" onClick={retry}>
              Retry
            </button>
          </div>
        ) : isTeams ? (
          <>
            <div className="games-display mb-1 text-center text-[9px] tracking-[0.2em] text-helios-dim">
              ALL GAMES · SUM OF BESTS
            </div>
            {subteams !== null && subteams.length === 0 ? (
              <EmptyState />
            ) : (
              restSubteams.length > 0 && (
                <ol className="flex max-h-44 flex-col gap-1 text-xs text-helios-text">
                  {restSubteams.map((s, i) => (
                    <li
                      key={s.subteam}
                      className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <RankChip rank={i + 4} />
                          <span className="truncate">{s.subteam}</span>
                        </span>
                        <span className="games-num shrink-0 font-semibold text-asu-gold">
                          {s.total}
                        </span>
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
            )}
          </>
        ) : (
          hasRest && (
            <ol className="grid max-h-44 w-full grid-cols-2 gap-1 text-xs text-helios-text">
              {restPlayers.map((e) => (
                <li
                  key={e.userId}
                  className="flex items-center justify-between gap-2 rounded-sm border border-helios-line bg-helios-panel px-2 py-1"
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
          )
        )}
      </div>
    </div>
  );
}
