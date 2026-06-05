import { useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import type { GameId } from "../api";
import {
  EmptyState,
  ErrorState,
  GameChips,
  PlayerRow,
  RankChip,
  SegmentedTabs,
  SkeletonRows,
  SubteamRow,
  useLeaderboardData,
  type Tab,
} from "./standings";

/* Central standings board on the picker screen — sits under the cabinet
 * grid at the same width, with game-switcher chips so any board is one
 * click away without launching a game. */

interface Props {
  client: SupabaseClient;
  /** Which game's board to show — lifted so playing a game keeps the
   *  lobby switcher in sync when you come back. */
  game: GameId;
  onGameChange: (g: GameId) => void;
  /** Bump to force a refetch (after a successful score submit). */
  refreshToken: number;
}

export function LobbyStandings({ client, game, onGameChange, refreshToken }: Props) {
  const [tab, setTab] = useState<Tab>("alltime");
  const { entries, subteams, error, loading, retry } =
    useLeaderboardData(client, tab, game, refreshToken);

  const isTeams = tab === "subteams";
  // Normalized podium rows so the card renderer doesn't juggle union types.
  const podium: { key: string; label: string; value: number; sub: string | null }[] = isTeams
    ? (subteams ?? []).slice(0, 3).map((s) => ({
        key: s.subteam, label: s.subteam, value: s.total, sub: null,
      }))
    : (entries ?? []).slice(0, 3).map((e) => ({
        key: e.userId, label: e.displayName, value: e.best, sub: e.subteam,
      }));
  const restPlayers = isTeams ? [] : (entries ?? []).slice(3, 11);
  const restSubteams = isTeams ? (subteams ?? []).slice(3) : [];
  const isEmpty = !loading && !error && (isTeams ? subteams?.length === 0 : entries?.length === 0);

  return (
    <section className="w-full rounded-sm border border-helios-line bg-helios-panel/60">
      {/* header rail */}
      <div className="flex items-center gap-3 border-b border-helios-line px-3 py-2">
        <span className="games-display shrink-0 text-[10px] tracking-[0.2em] text-helios-dim">
          STANDINGS
        </span>
        <span className="games-hazard h-[2px] min-w-0 flex-1 rounded-full opacity-50" />
        <SegmentedTabs tab={tab} onSelect={setTab} />
      </div>

      {/* game switcher / cross-game context — fixed-height slot, no jumps */}
      <div className="flex min-h-[34px] items-center justify-between gap-2 px-3 pt-2">
        <GameChips value={game} onSelect={onGameChange} muted={isTeams} />
        <span className="games-display shrink-0 text-[9px] tracking-[0.18em] text-helios-dim">
          {isTeams ? "ALL GAMES · SUM OF BESTS" : "TOP 10"}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-3">
        {error ? (
          <ErrorState message={error} onRetry={retry} />
        ) : loading ? (
          <>
            <div className="grid grid-cols-3 gap-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[52px] animate-pulse rounded-sm border border-helios-line bg-helios-panel" />
              ))}
            </div>
            <SkeletonRows count={2} />
          </>
        ) : isEmpty ? (
          <EmptyState />
        ) : (
          <>
            {/* podium — three mini-cards */}
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => {
                const p = podium[i];
                if (!p) {
                  return (
                    <div
                      key={i}
                      className="flex h-[52px] items-center justify-center rounded-sm border border-dashed border-helios-line/60 text-helios-line"
                    >
                      <span className="games-display text-[10px]">—</span>
                    </div>
                  );
                }
                return (
                  <div
                    key={p.key}
                    className={
                      "flex h-[52px] flex-col justify-center gap-0.5 rounded-sm border border-helios-line px-2.5 " +
                      (i === 0 ? "bg-asu-gold/[0.06]" : "bg-helios-panel")
                    }
                  >
                    <div className="flex items-center gap-1.5 text-xs text-helios-text">
                      <RankChip rank={i + 1} />
                      <span className="truncate">{p.label}</span>
                    </div>
                    <div className="pl-[26px]">
                      <span className="games-num text-sm font-bold text-asu-gold">{p.value}</span>
                      {p.sub && <span className="ml-1.5 text-[10px] text-helios-dim">{p.sub}</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* the rest of the field */}
            {isTeams
              ? restSubteams.length > 0 && (
                  <ol className="flex flex-col gap-1 text-xs text-helios-text">
                    {restSubteams.map((s, i) => (
                      <SubteamRow key={s.subteam} ranking={s} rank={i + 4} />
                    ))}
                  </ol>
                )
              : restPlayers.length > 0 && (
                  <ol className="grid grid-cols-2 gap-1 text-xs text-helios-text">
                    {restPlayers.map((e) => (
                      <PlayerRow key={e.userId} entry={e} />
                    ))}
                  </ol>
                )}
          </>
        )}
      </div>
    </section>
  );
}
