/* What just happened, the moment the simulator closes.
 *
 * A driver finishes a session, alt-tabs back, and without this finds the same
 * screen they left — their runs sitting behind a refresh button, with no sign
 * that anything happened. The interesting question at that moment is never
 * "what is in the archive", it is "how did I just do": did I improve, what was
 * the best lap, how much did the cones cost.
 *
 * So this is deliberately a summary of ONE session and not a second
 * leaderboard. It answers that question and then gets out of the way — the
 * Runs table it is sitting on top of is where the detail lives.
 */

import { useEffect, useMemo } from "react";
import { IconX, IconTrophy, IconFlag, IconAlertTriangle } from "@tabler/icons-react";
import {
  bestLapWentOffCourse, fmtGap, fmtTime, hasTrustworthySectors, isRankable, runBest, trackName,
  unrankedReason, type SimRun,
} from "../api";
import { bestPerCourse, boardLabel, courseName, sessionResult } from "../lib/leaderboard";

export interface SessionWindow {
  startedAtMs: number;
  endedAtMs: number;
}

/**
 * The runs written while that simulator was open.
 *
 * Matched on the run's own `startedAt`, not on file times: a run is stamped
 * when the driver pressed start, which is the thing being asked about. The
 * window is opened a little at each end because the two clocks are the same
 * clock but the events are not simultaneous — the process starts before the
 * first run and the last run is written just before the window closes.
 */
export function runsInSession(runs: SimRun[], win: SessionWindow): SimRun[] {
  const from = win.startedAtMs - 5_000;
  const to = win.endedAtMs + 30_000;
  return runs
    .filter((r) => {
      if (!r.startedAt) return false;
      const t = Date.parse(r.startedAt);
      return Number.isFinite(t) && t >= from && t <= to;
    })
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

export function SessionSummary({
  runs,
  session,
  allRuns,
  onOpenRun,
  onReplay,
  onClose,
  canReplay,
  viewerId = null,
}: {
  runs: SimRun[];
  session: SessionWindow;
  /** Every run, so "is this a personal best" can look past this session. */
  allRuns: SimRun[];
  /** The signed-in account. The card says "your" only to the person whose
   *  runs they are; on a shared rig that is often somebody else. */
  viewerId?: string | null;
  onOpenRun: (id: string) => void;
  onReplay: (id: string) => void;
  onClose: () => void;
  canReplay: boolean;
}) {
  // Esc closes it, like every other transient panel in Helios.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stats = useMemo(() => {
    // Best PER COURSE. One minimum across the session called a 4.352 accel run
    // "the best lap" of a session that was forty autocross laps. The headline
    // is the course the session was mostly spent on; the others are listed
    // beside it with their own bests.
    const courses = bestPerCourse(runs);
    const head = courses[0] ?? null;
    const best = head ? runs.find((r) => r.runId === head.runId) ?? null : null;
    const bestTime = best ? runBest(best) : null;

    // What that lap did on its board -- the same board the Leaderboard draws
    // (course, car model, device, physics era), against the same driver's
    // runs from BEFORE this one. Course and driver alone measured a first
    // 4-wheel lap against a bicycle best. Null when it cannot rank: a lap with
    // traction control on is not a personal best, and the card used to say it
    // was, in green, above a list that flagged the same run as unranked.
    const result = best ? sessionResult(allRuns, best) : null;

    const laps = runs.reduce((a, r) => a + (r.stats.laps ?? 0), 0);
    const cones = runs.reduce((a, r) => a + (r.stats.totalCones ?? 0), 0);
    const off = runs.reduce((a, r) => a + (r.stats.totalOffCourse ?? 0), 0);
    const driven = runs.reduce((a, r) => a + (r.stats.durationS ?? 0), 0);
    const distance = runs.reduce((a, r) => a + (r.stats.distanceM ?? 0), 0);
    const unranked = runs.filter((r) => !isRankable(r)).length;
    /** The quickest run of the session cannot rank, so nothing about it is a record. */
    const bestUnranked = !!best && !isRankable(best);
    const peakLat = runs.reduce((a, r) => Math.max(a, r.stats.peakLatG ?? 0), 0);

    return {
      best, bestTime, result, others: courses.slice(1), laps, cones, off, driven, distance, unranked,
      bestUnranked, peakLat,
    };
  }, [runs, allRuns]);

  /** "your" to the driver, their name to anybody else at the rig. */
  const whose = stats.best && viewerId && stats.best.driverId === viewerId ? "your" : `${stats.best?.driver ?? "their"}'s`;
  const Whose = whose === "your" ? "Your" : whose;

  const minutes = Math.round(stats.driven / 60);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-helios-line bg-helios-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-helios-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Session finished</h2>
            <p className="mt-0.5 text-xs text-helios-dim">
              {runs.length === 0
                ? "The simulator closed without filing a run."
                : `${runs.length} run${runs.length === 1 ? "" : "s"}` +
                  `${stats.laps ? `, ${stats.laps} lap${stats.laps === 1 ? "" : "s"}` : ""}` +
                  `${minutes >= 1 ? `, ${minutes} min driving` : ""}` +
                  `${stats.distance >= 100 ? `, ${(stats.distance / 1000).toFixed(1)} km` : ""}`}
            </p>
          </div>
          <button
            className="rounded p-1 text-helios-dim transition hover:text-helios-text"
            title="Close (Esc)"
            onClick={onClose}
          >
            <IconX size={16} />
          </button>
        </header>

        {runs.length === 0 ? (
          <p className="px-5 py-6 text-center text-xs text-helios-dim">
            Nothing to show. A run is filed once a lap has been completed — plus three
            seconds and fifteen metres of driving — so a session that never crossed the
            finish line leaves nothing behind. Free roam at MIS has no finish line at
            all, so it never files a run.
          </p>
        ) : (
          <>
            {stats.best && stats.bestTime != null && (
              <section className="flex items-center gap-4 border-b border-helios-line bg-asu-gold/10 px-5 py-4">
                <IconTrophy size={24} className="shrink-0 text-asu-gold" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-helios-dim">
                    Best this session · {courseName(stats.best.track)}
                  </div>
                  <div className="truncate text-sm">
                    <span className="font-mono text-xl font-semibold text-asu-gold">
                      {fmtTime(stats.bestTime)}
                    </span>
                    <span className="ml-3 text-helios-dim">{stats.best.driver}</span>
                  </div>
                  {stats.bestUnranked || !stats.result ? (
                    <div className="mt-0.5 text-xs text-helios-dim">
                      Not ranked — {unrankedReason(stats.best) ?? "see the run"}
                    </div>
                  ) : (
                    <>
                      {stats.result.improvement != null && stats.result.improvement > 0.0005 ? (
                        <div className="mt-0.5 text-xs text-helios-success">
                          {stats.result.improvement.toFixed(3)} s quicker than {whose} previous best on this board
                        </div>
                      ) : stats.result.previousBest != null ? (
                        <div className="mt-0.5 text-xs text-helios-dim">
                          {Whose} best here is still {fmtTime(stats.result.previousBest)}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-xs text-helios-dim">
                          First ranked time on this board
                        </div>
                      )}
                      {/* Where it lands on the board the Leaderboard draws. */}
                      <div className="mt-0.5 truncate text-xs" data-testid="session-board-line">
                        {stats.result.record ? (
                          <span className="font-semibold uppercase tracking-wider text-asu-gold">
                            Team record
                            <span className="ml-1.5 font-normal normal-case tracking-normal text-helios-dim">
                              on {boardLabel(stats.result.key)}
                            </span>
                          </span>
                        ) : stats.result.standing.entry && stats.result.standing.leader ? (
                          <span className="text-helios-dim">
                            P{stats.result.standing.entry.rank} on {boardLabel(stats.result.key)},{" "}
                            <span className="font-mono">
                              {fmtGap(stats.result.standing.entry.best - stats.result.standing.leader.best)}
                            </span>{" "}
                            to {viewerId && stats.result.standing.leader.driverId === viewerId ? "you" : stats.result.standing.leader.driver}
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                  {stats.others.length > 0 && (
                    <div className="mt-1 truncate text-[11px] text-helios-muted" data-testid="session-other-courses">
                      Also:{" "}
                      {stats.others.map((c, i) => (
                        <span key={c.track}>
                          {i > 0 && " · "}
                          {c.short} <span className="font-mono text-helios-dim">{fmtTime(c.best)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  className="shrink-0 rounded border border-helios-line px-2.5 py-1.5 text-xs transition hover:border-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!canReplay}
                  title={canReplay ? "Watch that run" : "The simulator is not installed here"}
                  onClick={() => onReplay(stats.best!.runId)}
                >
                  Replay
                </button>
              </section>
            )}

            <dl className="grid grid-cols-4 gap-px border-b border-helios-line bg-helios-line">
              <Stat label="Laps" value={String(stats.laps)} />
              <Stat label="Cones" value={String(stats.cones)} warn={stats.cones > 0} />
              <Stat label="Off course" value={String(stats.off)} warn={stats.off > 0} />
              <Stat label="Peak lat" value={`${stats.peakLat.toFixed(2)} g`} />
            </dl>

            <ul className="max-h-56 overflow-y-auto">
              {runs.map((r) => {
                const t = runBest(r);
                const isBest = stats.best?.runId === r.runId;
                return (
                  <li key={r.runId}>
                    <button
                      className="flex w-full items-baseline gap-3 border-b border-helios-line/60 px-5 py-2 text-left text-xs transition hover:bg-helios-line/25"
                      onClick={() => onOpenRun(r.runId)}
                    >
                      {/* Wide enough for "05:22 PM", which wrapped at w-14. */}
                      <span className="w-[4.75rem] shrink-0 whitespace-nowrap font-mono text-helios-dim">
                        {r.startedAt
                          ? new Date(r.startedAt).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </span>
                      {/* A lap thrown out for going off course has no time
                          either, and "no lap" is not what happened to it. */}
                      <span className={"w-20 shrink-0 font-mono " + (isBest ? "text-asu-gold" : "")}>
                        {t != null ? fmtTime(t) : bestLapWentOffCourse(r) ? "off course" : "no lap"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-helios-dim">
                        {trackName(r.track)}
                        {r.stats.totalCones ? ` · ${r.stats.totalCones}c` : ""}
                        {!hasTrustworthySectors(r) ? " · older format" : ""}
                      </span>
                      {!isRankable(r) && (
                        <IconAlertTriangle
                          size={13}
                          className="shrink-0 text-helios-warn"
                          title="Not ranked — see the run for why"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {stats.unranked > 0 && (
              <p className="flex items-center gap-2 border-t border-helios-line px-5 py-2.5 text-[11px] text-helios-dim">
                <IconFlag size={13} className="shrink-0 text-helios-warn" />
                {stats.unranked} of these will not go on the board. Open the run to see why.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-helios-panel px-3 py-2.5 text-center">
      <dt className="text-[10px] uppercase tracking-wider text-helios-dim">{label}</dt>
      <dd className={"mt-0.5 font-mono text-sm " + (warn ? "text-helios-warn" : "")}>{value}</dd>
    </div>
  );
}
