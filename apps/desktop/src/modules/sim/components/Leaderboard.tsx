import { useMemo } from "react";
import { IconMovie, IconTrendingUp, IconTrophy } from "@tabler/icons-react";
import { fmtGap, fmtTime, fmtWhen, type SimRun } from "../api";
import { buildActivity, buildBoards, buildImprovements } from "../lib/leaderboard";

interface Props {
  runs: SimRun[];
  canReplay: boolean;
  onOpenRun: (runId: string) => void;
  onReplayRun: (runId: string) => void;
}

export function Leaderboard({ runs, canReplay, onOpenRun, onReplayRun }: Props) {
  const boards = useMemo(() => buildBoards(runs), [runs]);
  const improvements = useMemo(() => buildImprovements(runs), [runs]);
  const activity = useMemo(() => buildActivity(runs), [runs]);

  if (runs.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-helios-dim">
        No runs yet. The board fills itself the first time somebody drives.
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Runs" value={activity.runs.toLocaleString()} />
        <Stat label="Drivers" value={String(activity.drivers)} />
        <Stat label="Wheel time" value={fmtDuration(activity.secondsDriven)} />
        <Stat label="Distance" value={`${(activity.metresDriven / 1000).toFixed(1)} km`} />
      </section>

      {activity.fastest && (
        <section className="flex items-center gap-4 rounded-lg border border-asu-gold/40 bg-asu-gold/10 px-5 py-4">
          <IconTrophy size={26} className="shrink-0 text-asu-gold" />
          <div className="min-w-0 flex-1">
            <div
              className="text-[10px] uppercase tracking-wider text-helios-dim"
              title="The best SCORED lap: raw time plus two seconds a cone and ten an excursion, which is what an event scores"
            >
              Best lap anyone has scored
            </div>
            <div className="truncate text-sm">
              <span className="font-mono text-xl font-semibold text-asu-gold">
                {fmtTime(activity.fastest.time)}
              </span>
              <span className="ml-3 font-medium">{activity.fastest.driver}</span>
              <span className="ml-2 text-helios-dim">on {activity.fastest.trackName}</span>
            </div>
          </div>
          <button
            className="shrink-0 rounded border border-helios-line bg-helios-panel px-3 py-1.5 text-xs transition hover:border-asu-gold"
            onClick={() => onOpenRun(activity.fastest!.runId)}
          >
            Open it
          </button>
        </section>
      )}

      {boards.map((b) => (
        <section key={b.track} className="rounded-lg border border-helios-line bg-helios-panel">
          <header className="flex items-baseline justify-between border-b border-helios-line px-5 py-3">
            <h3 className="text-sm font-semibold">{b.trackName}</h3>
            <span className="text-[11px] text-helios-muted">
              {b.runCount} ranked run{b.runCount === 1 ? "" : "s"}
              {b.unrankedCount > 0 && ` · ${b.unrankedCount} not ranked`}
            </span>
          </header>

          {b.entries.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-helios-dim">
              Nothing ranked here yet. Every run on this course was either started
              outside Helios (so nobody can say who drove it), had driver aids on, was
              set by the robot driver, or never completed a lap. Launch from the
              Launch tab while signed in and the time counts.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-helios-muted">
                  <th className="px-5 py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Driver</th>
                  <th className="py-2 text-right font-medium">Best</th>
                  <th className="py-2 text-right font-medium">Gap</th>
                  <th
                    className="py-2 text-right font-medium"
                    title="That same lap before penalties — the gap to Best is what the cones cost"
                  >
                    Raw
                  </th>
                  <th className="py-2 text-right font-medium" title="Their own quickest sectors added up">
                    Theoretical
                  </th>
                  <th className="py-2 text-right font-medium">Runs</th>
                  <th className="py-2 pl-3 font-medium">Set</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {b.entries.map((e) => (
                  <tr
                    key={e.driverId}
                    className="cursor-pointer border-t border-helios-line/60 transition hover:bg-helios-line/25"
                    onClick={() => onOpenRun(e.runId)}
                  >
                    <td className="px-5 py-2 font-mono text-helios-dim">{e.rank}</td>
                    <td className="py-2 font-medium">{e.driver}</td>
                    <td className={"py-2 text-right font-mono " + (e.rank === 1 ? "text-asu-gold" : "")}>
                      {fmtTime(e.best)}
                    </td>
                    <td className="py-2 text-right font-mono text-helios-dim">
                      {e.rank === 1 ? "—" : fmtGap(e.gap)}
                    </td>
                    <td className="py-2 text-right font-mono text-helios-dim">{fmtTime(e.bestRaw)}</td>
                    <td className="py-2 text-right font-mono text-helios-dim">
                      {fmtTime(e.theoretical)}
                    </td>
                    <td className="py-2 text-right font-mono text-helios-dim">{e.runs}</td>
                    <td className="whitespace-nowrap py-2 pl-3 text-helios-dim">{fmtWhen(e.when)}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        title={canReplay ? "Watch that lap" : "The simulator is not installed here"}
                        disabled={!canReplay}
                        onClick={(ev) => { ev.stopPropagation(); onReplayRun(e.runId); }}
                        className="rounded border border-helios-line p-1 text-helios-dim transition hover:border-asu-gold hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <IconMovie size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {b.sectorRecords.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-helios-line px-5 py-2.5 text-[11px]">
              <span className="text-helios-muted">Team sector records</span>
              {b.sectorRecords.map((s, i) => (
                <span key={i} className="font-mono">
                  <span className="text-helios-muted">S{i + 1}</span>{" "}
                  {s == null ? "—" : s.toFixed(3)}
                </span>
              ))}
              {b.teamTheoretical != null && (
                <span className="ml-auto font-mono text-asu-gold" title="Every sector at its record, added up">
                  Perfect lap {fmtTime(b.teamTheoretical)}
                </span>
              )}
            </div>
          )}
        </section>
      ))}

      {improvements.length > 0 && (
        <section className="rounded-lg border border-helios-line bg-helios-panel">
          <header className="flex items-center gap-2 border-b border-helios-line px-5 py-3">
            <IconTrendingUp size={16} className="text-helios-success" />
            <h3 className="text-sm font-semibold">Time found</h3>
            <span className="text-[11px] text-helios-muted">
              since each driver's first run on a course
            </span>
          </header>
          <table className="w-full border-collapse text-xs">
            <tbody>
              {improvements.slice(0, 12).map((im) => (
                <tr key={`${im.driverId}-${im.track}`} className="border-t border-helios-line/60">
                  <td className="px-5 py-2 font-medium">{im.driver}</td>
                  <td className="py-2 text-helios-dim">{im.trackName}</td>
                  <td className="py-2 text-right font-mono text-helios-dim">{fmtTime(im.first)}</td>
                  <td className="py-2 text-center text-helios-muted">→</td>
                  <td className="py-2 font-mono">{fmtTime(im.best)}</td>
                  <td className="px-5 py-2 text-right font-mono text-helios-success">
                    −{im.gained.toFixed(3)} s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-helios-line bg-helios-panel px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-helios-muted">{label}</div>
      <div className="font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
