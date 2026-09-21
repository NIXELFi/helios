import { useMemo, useState } from "react";
import { IconMovie, IconTrendingUp, IconTrophy } from "@tabler/icons-react";
import { fmtGap, fmtTime, fmtWhen, parseGeneratedId, type SimRun } from "../api";
import {
  buildActivity, buildBoards, buildConsistencyBoards, buildImprovements,
  CONSISTENCY_MIN_RUNS, CONSISTENCY_WINDOW,
} from "../lib/leaderboard";
import { DEVICE_CLASSES, deviceClass, type DeviceClass } from "../api";

interface Props {
  runs: SimRun[];
  canReplay: boolean;
  onOpenRun: (runId: string) => void;
  onReplayRun: (runId: string) => void;
}

/** Which boards are worth offering, given what has actually been driven. */
function classesPresent(runs: SimRun[]): DeviceClass[] {
  const seen = new Set(runs.map(deviceClass));
  return DEVICE_CLASSES.filter((c) => seen.has(c.id)).map((c) => c.id);
}

/**
 * The competition courses and the generated ones are different boards.
 *
 * A generated course is named by its seed and exists once somebody has
 * driven it, so a single board of everything would fill with one-run
 * "courses" and bury the two that the team actually competes on. The
 * competition tab is the default and never shows a generated course; the
 * generated tab appears only once there is something on it.
 */
export type BoardScope = "competition" | "generated";
export const isGeneratedRun = (r: Pick<SimRun, "track">): boolean => parseGeneratedId(r.track) !== null;

export function Leaderboard({ runs: allRuns, canReplay, onOpenRun, onReplayRun }: Props) {
  const [scope, setScope] = useState<BoardScope>("competition");
  const generatedCount = useMemo(() => allRuns.filter(isGeneratedRun).length, [allRuns]);
  const runs = useMemo(
    () => allRuns.filter((r) => isGeneratedRun(r) === (scope === "generated")),
    [allRuns, scope],
  );
  /**
   * One board per device class.
   *
   * A wheel, a controller and a keyboard are not comparable and a single list
   * of all three does not rank drivers, it ranks hardware: a wheel has a real
   * stop at a real angle and two hundred times the resolution of a stick, and
   * a keyboard is a switch that software ramps into a steering command.
   *
   * Defaults to whichever class has the most runs rather than to "everything",
   * because "everything" is the one view that is actively misleading -- and
   * the tab bar only offers classes somebody has actually driven, so a team
   * that is all on wheels never sees the question.
   */
  const present = useMemo(() => classesPresent(runs), [runs]);
  const [cls, setCls] = useState<DeviceClass | null>(null);
  const active: DeviceClass | null = cls && present.includes(cls)
    ? cls
    : present.length
      ? (present
          .map((c) => [c, runs.filter((r) => deviceClass(r) === c).length] as const)
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
      : null;

  const shown = useMemo(
    () => (active ? runs.filter((r) => deviceClass(r) === active) : runs),
    [runs, active],
  );
  const boards = useMemo(() => buildBoards(shown), [shown]);
  /**
   * Two ways to rank the same runs. "Fastest" is the lap where everything
   * came together; "Average" is each driver's mean over their last
   * `CONSISTENCY_WINDOW` clean runs, which is the number an autocross with two
   * runs a driver actually pays for. The choice is per page, not per course:
   * a person comparing two courses wants the same rule on both.
   */
  const [mode, setMode] = useState<"fastest" | "average">("fastest");
  const consistency = useMemo(() => buildConsistencyBoards(shown), [shown]);
  const improvements = useMemo(() => buildImprovements(shown), [shown]);
  const activity = useMemo(() => buildActivity(shown), [shown]);

  const scopeTabs = generatedCount > 0 && (
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Courses">
      {([
        ["competition", "Competition courses", allRuns.length - generatedCount],
        ["generated", "Generated courses", generatedCount],
      ] as const).map(([id, label, n]) => (
        <button
          key={id}
          role="tab"
          onClick={() => setScope(id)}
          aria-selected={scope === id}
          className={
            "rounded border px-2.5 py-1 text-xs transition " +
            (scope === id
              ? "border-asu-gold bg-asu-gold/15 text-helios-text"
              : "border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text")
          }
        >
          {label}
          <span className="ml-1.5 text-helios-muted">{n}</span>
        </button>
      ))}
      <span className="ml-auto text-[11px] text-helios-muted">
        {scope === "generated"
          ? "One board per seed. A seed is a course; share it and race it."
          : "The 2026 Michigan courses. Generated courses keep their own tab."}
      </span>
    </div>
  );

  if (runs.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
        {scopeTabs}
        <p className="p-8 text-center text-sm text-helios-dim">
          No runs yet. The board fills itself the first time somebody drives.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      {scopeTabs}
      {/* Only when there is a choice to make. A team all on wheels never sees
          this, and the one view deliberately not offered is "all three at
          once" -- see the note on `active`. */}
      {present.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {present.map((id) => {
            const meta = DEVICE_CLASSES.find((c) => c.id === id)!;
            const n = runs.filter((r) => deviceClass(r) === id).length;
            const on = id === active;
            return (
              <button
                key={id}
                onClick={() => setCls(id)}
                aria-pressed={on}
                className={
                  "rounded border px-2.5 py-1 text-xs transition " +
                  (on
                    ? "border-asu-gold bg-asu-gold/15 text-helios-text"
                    : "border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text")
                }
              >
                {meta.name}
                <span className="ml-1.5 text-helios-muted">{n}</span>
              </button>
            );
          })}
          <span className="ml-auto text-[11px] text-helios-muted">
            Separate boards: a wheel, a pad and a keyboard are not the same instrument.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Ranking">
        {([
          ["fastest", "Fastest lap", "Each driver's single best scored lap"],
          ["average", `Average of last ${CONSISTENCY_WINDOW}`, `Each driver's mean scored lap over their most recent ${CONSISTENCY_WINDOW} clean runs on the course`],
        ] as const).map(([id, label, tip]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            aria-pressed={mode === id}
            title={tip}
            className={
              "rounded border px-2.5 py-1 text-xs transition " +
              (mode === id
                ? "border-asu-gold bg-asu-gold/15 text-helios-text"
                : "border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text")
            }
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-helios-muted">
          {mode === "fastest"
            ? "The one lap where everything came together."
            : `Doing it every time: the mean of a driver's newest ${CONSISTENCY_WINDOW} clean runs, at least ${CONSISTENCY_MIN_RUNS} to rank.`}
        </span>
      </div>

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
              title="The best SCORED lap: raw time plus two seconds a cone. A lap that went off course has no time here — stricter than FSAE's +20 s, on purpose."
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

      {mode === "average" && consistency.map((b) => (
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
              Nobody has {CONSISTENCY_MIN_RUNS} clean ranked runs on this course yet, so there is no
              average to rank. Drive it a few more times and this fills in.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-helios-muted">
                  <th className="px-5 py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Driver</th>
                  <th className="py-2 text-right font-medium" title={`Mean scored lap over the newest ${CONSISTENCY_WINDOW} clean runs`}>
                    Average
                  </th>
                  <th className="py-2 text-right font-medium">Gap</th>
                  <th className="py-2 text-right font-medium" title="Standard deviation of those laps: how far a typical run sits from the average">
                    Spread
                  </th>
                  <th className="py-2 text-right font-medium" title="The quickest lap inside the window">
                    Best
                  </th>
                  <th className="py-2 text-right font-medium" title={`Runs in the average, out of the ${CONSISTENCY_WINDOW} the window holds`}>
                    Runs
                  </th>
                  <th className="py-2 pl-3 font-medium">Latest</th>
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
                      {fmtTime(e.average)}
                    </td>
                    <td className="py-2 text-right font-mono text-helios-dim">
                      {e.rank === 1 ? "—" : fmtGap(e.gap)}
                    </td>
                    <td className="py-2 text-right font-mono text-helios-dim">±{e.spread.toFixed(3)}</td>
                    <td className="py-2 text-right font-mono text-helios-dim">{fmtTime(e.best)}</td>
                    <td className="py-2 text-right font-mono text-helios-dim" data-testid="counted">
                      {e.counted}<span className="text-helios-muted">/{CONSISTENCY_WINDOW}</span>
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-helios-dim">{fmtWhen(e.latest)}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        title={canReplay ? "Watch their best lap in the window" : "The simulator is not installed here"}
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

          {b.pending.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-helios-line px-5 py-2.5 text-[11px] text-helios-muted">
              <span>Not enough clean runs yet</span>
              {b.pending.map((p) => (
                <span key={p.driverId}>
                  {p.driver} <span className="font-mono">{p.counted}/{CONSISTENCY_MIN_RUNS}</span>
                </span>
              ))}
            </div>
          )}
        </section>
      ))}

      {mode === "fastest" && boards.map((b) => (
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
              outside Helios (so nobody can say who drove it), went off course, had
              driver aids on, was set by the robot driver, or never completed a lap.
              Launch from the Launch tab while signed in and the time counts.
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
