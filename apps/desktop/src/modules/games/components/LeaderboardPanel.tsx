import { useEffect, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchAllTime, fetchSubteams, fetchWeekly,
  type GameId, type LeaderboardEntry, type SubteamRanking,
} from "../api";
import { GAMES } from "../registry";

type Tab = "alltime" | "weekly" | "subteams";

interface Props {
  client: SupabaseClient;
  gameId: GameId;
  /** Bump to force a refetch (after a successful score submit). */
  refreshToken: number;
}

export function LeaderboardPanel({ client, gameId, refreshToken }: Props) {
  const [tab, setTab] = useState<Tab>("alltime");
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [subteams, setSubteams] = useState<SubteamRanking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

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
  }, [client, tab, gameId, refreshToken, retry]);

  const gameTitle = GAMES.find((g) => g.id === gameId)?.title ?? gameId;

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2 border-l border-helios-line bg-helios-base p-3">
      <div className="flex gap-1">
        {(
          [["alltime", "All-time"], ["weekly", "Weekly"], ["subteams", "Subteams"]] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              "rounded-sm border px-2 py-1 text-xs transition-colors " +
              (tab === id
                ? "border-asu-gold bg-asu-gold font-semibold text-helios-base"
                : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold")
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-helios-dim">
        {tab === "subteams" ? "All games · sum of bests" : gameTitle}
      </div>
      {error ? (
        <div className="text-xs text-red-300">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : tab === "subteams" ? (
        subteams === null ? (
          <div className="text-xs text-helios-dim">Loading…</div>
        ) : subteams.length === 0 ? (
          <div className="text-xs text-helios-dim">No scores yet. Be the first.</div>
        ) : (
          <ol className="flex flex-col gap-1 overflow-y-auto text-xs text-helios-text">
            {subteams.map((s, i) => (
              <li key={s.subteam} className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1">
                <div className="flex justify-between">
                  <span>
                    <span className="text-helios-dim">{i + 1}.</span> {s.subteam}
                  </span>
                  <span className="font-semibold text-asu-gold">{s.total}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-helios-dim">
                  {GAMES.filter((g) => s.perGame[g.id] !== undefined)
                    .map((g) => `${g.title} ${s.perGame[g.id]}`)
                    .join(" · ")}
                </div>
              </li>
            ))}
          </ol>
        )
      ) : entries === null ? (
        <div className="text-xs text-helios-dim">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-helios-dim">No scores yet. Be the first.</div>
      ) : (
        <ol className="flex flex-col gap-1 overflow-y-auto text-xs text-helios-text">
          {entries.map((e) => (
            <li
              key={e.userId}
              className="flex justify-between rounded-sm border border-helios-line bg-helios-panel px-2 py-1"
            >
              <span className="truncate">
                <span className="text-helios-dim">{e.rank}.</span> {e.displayName}
                {e.subteam && <span className="text-helios-dim"> · {e.subteam}</span>}
              </span>
              <span className="font-semibold text-asu-gold">{e.best}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
