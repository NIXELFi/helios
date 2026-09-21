import { useEffect, useMemo, useState } from "react";
import { IconChartLine, IconMovie, IconTrendingUp, IconTrophy, IconX } from "@tabler/icons-react";
import { fmtGap, fmtTime, fmtWhen, parseGeneratedId, type SimRun } from "../api";
import {
  buildActivity, buildBoards, buildConsistencyBoards, buildImprovements,
  compareOwnSector, compareRecord,
  CONSISTENCY_MIN_RUNS, CONSISTENCY_WINDOW,
  type SectorComparison, type SectorTime, type TrackBoard,
} from "../lib/leaderboard";
import { DEVICE_CLASSES, deviceClass, type DeviceClass } from "../api";

interface Props {
  runs: SimRun[];
  canReplay: boolean;
  onOpenRun: (runId: string) => void;
  onReplayRun: (runId: string) => void;
  /** The signed-in driver, whose laps a sector is compared with. */
  driverId?: string | null;
  /** Watch a sector in the simulator, the driver's own lap as the ghost. */
  onWatchSector?: (c: SectorComparison) => void;
  /** Open the sector's lap and the driver's own in Logs, side by side. */
  onCompareSector?: (c: SectorComparison) => void;
}

/** Which sector card is open: a team record, or the driver's own sectors. */
type OpenCard = { track: string; mode: "record" | "own"; sector: number } | null;

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

export function Leaderboard({
  runs: allRuns, canReplay, onOpenRun, onReplayRun,
  driverId = null, onWatchSector, onCompareSector,
}: Props) {
  const [scope, setScope] = useState<BoardScope>("competition");
  const [card, setCard] = useState<OpenCard>(null);
  // Escape closes the card, wherever focus is.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCard(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card]);
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
                      {/* Your own row only: where your perfect lap beats your
                          real one, sector by sector. */}
                      {driverId && e.driverId === driverId && e.theoretical != null ? (
                        <button
                          type="button"
                          aria-expanded={card?.track === b.track && card.mode === "own"}
                          title="Your best sectors against your best lap: where the perfect lap beats the real one"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const open = card?.track === b.track && card.mode === "own";
                            setCard(open ? null : { track: b.track, mode: "own", sector: biggestGain(b, e.driverId, shown) });
                          }}
                          className="rounded px-1 underline decoration-dotted underline-offset-2 transition hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
                        >
                          {fmtTime(e.theoretical)}
                        </button>
                      ) : fmtTime(e.theoretical)}
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
              <span
                className="text-helios-muted"
                title="The quickest each sector has been driven, two seconds added for every cone struck in it. Click one to watch it against your own lap."
              >
                Team sector records
              </span>
              {b.sectorRecords.map((s, i) => {
                if (s == null) {
                  return (
                    <span key={i} className="font-mono">
                      <span className="text-helios-muted">S{i + 1}</span> —
                    </span>
                  );
                }
                const open = card?.track === b.track && card.mode === "record" && card.sector === i;
                return (
                  <button
                    key={i}
                    type="button"
                    aria-expanded={open}
                    aria-label={`Sector ${i + 1} record ${s.time.toFixed(3)} seconds by ${s.driver}`}
                    title={`${s.driver}${s.lap != null ? `, lap ${s.lap}` : ""}${s.cones ? ` · incl. ${coneText(s.cones)}` : ""}`}
                    onClick={() => setCard(open ? null : { track: b.track, mode: "record", sector: i })}
                    className={
                      "-mx-1 rounded px-1 font-mono transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
                      (open ? "bg-asu-gold/15 text-helios-text" : "hover:bg-helios-line/40")
                    }
                  >
                    <span className="text-helios-muted">S{i + 1}</span>{" "}
                    {s.time.toFixed(3)}
                    {s.cones > 0 && <span className="ml-0.5 text-helios-warn" aria-hidden>•</span>}
                  </button>
                );
              })}
              {b.teamTheoretical != null && (
                <span className="ml-auto font-mono text-asu-gold" title="Every sector at its record, added up">
                  Perfect lap {fmtTime(b.teamTheoretical)}
                </span>
              )}
            </div>
          )}

          {card?.track === b.track && (
            <SectorCard
              key={`${card.mode}-${card.sector}`}
              board={b}
              runs={shown}
              mode={card.mode}
              sector={card.sector}
              driverId={driverId}
              canReplay={canReplay}
              onPickSector={(i) => setCard({ ...card, sector: i })}
              onClose={() => setCard(null)}
              onWatch={onWatchSector}
              onCompare={onCompareSector}
            />
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

function coneText(n: number): string {
  return `${n} cone${n === 1 ? "" : "s"}`;
}

/** "12.430 s (incl. 1 cone)" -- the penalty is part of the time, and says so. */
function sectorText(s: SectorTime): string {
  return `${s.time.toFixed(3)} s${s.cones > 0 ? ` (incl. ${coneText(s.cones)})` : ""}`;
}

/** The sector where the driver's perfect lap gains most on their real one. */
function biggestGain(board: TrackBoard, driverId: string, runs: SimRun[]): number {
  let best = 0;
  let gain = -Infinity;
  const n = board.entries.find((e) => e.driverId === driverId)?.bestSectors.length ?? 0;
  for (let i = 0; i < n; i++) {
    const c = compareOwnSector(runs, board, i, driverId);
    const g = c?.mine ? c.mine.time - c.target.time : -Infinity;
    if (g > gain) { gain = g; best = i; }
  }
  return best;
}

/**
 * Why a sector's buttons are off, or null for each that is on.
 *
 * The record's own lap has to be somewhere -- retention deletes most laps --
 * and, for anybody else's record, so does one of yours to put beside it.
 */
function blockedReasons(
  c: SectorComparison,
  mode: "record" | "own",
  driverId: string | null,
  canReplay: boolean,
): { watch: string | null; compare: string | null } {
  const t = c.target;
  const yours = !!driverId && t.driverId === driverId;
  if (!t.hasTelemetry) {
    const why = t.evicted
      ? "This lap was removed by the team's storage budget, so it can be read but not watched."
      : `${yours ? "Your" : `${t.driver}'s`} lap is no longer stored, so it can be read but not watched. Only a few laps per driver per course keep their telemetry.`;
    return { watch: why, compare: why };
  }
  if (!driverId) {
    const why = "Sign in to compare it with your own laps.";
    return { watch: why, compare: why };
  }
  let watch: string | null = null;
  let compare: string | null = null;
  if (!c.against) {
    compare = mode === "own"
      ? "Your best lap has no telemetry to compare it with."
      : yours
        ? "You have no other lap with telemetry on this course to compare it with."
        : "You have no lap with telemetry on this course to compare it with.";
    // Your own time can still be watched on its own; anybody else's is only
    // worth watching against something of yours.
    if (!yours) watch = compare;
  }
  if (!watch && !canReplay) watch = "The simulator is not installed here.";
  return { watch, compare };
}

/**
 * The card a sector opens: what the time is, where it came from, how far off
 * it you are, and the two ways to see why.
 *
 * Inline beneath the records rather than floating: it has buttons in it, and a
 * popover that has to be chased with the mouse is one a keyboard cannot reach.
 * Escape or the cross closes it.
 */
function SectorCard({
  board, runs, mode, sector, driverId, canReplay, onPickSector, onClose, onWatch, onCompare,
}: {
  board: TrackBoard;
  runs: SimRun[];
  mode: "record" | "own";
  sector: number;
  driverId: string | null;
  canReplay: boolean;
  onPickSector: (i: number) => void;
  onClose: () => void;
  onWatch?: (c: SectorComparison) => void;
  onCompare?: (c: SectorComparison) => void;
}) {
  const c = mode === "record"
    ? compareRecord(runs, board, sector, driverId)
    : driverId ? compareOwnSector(runs, board, sector, driverId) : null;
  const n = mode === "record"
    ? board.sectorRecords.length
    : board.entries.find((e) => e.driverId === driverId)?.bestSectors.length ?? 0;
  const label = `S${sector + 1}`;
  const why = c
    ? blockedReasons(c, mode, driverId, canReplay)
    : { watch: "Nothing to show", compare: "Nothing to show" };
  const watchBlocked = why.watch ?? (onWatch ? null : "Not available here");
  const compareBlocked = why.compare ?? (onCompare ? null : "Not available here");

  const t = c?.target;
  const yours = !!t && !!driverId && t.driverId === driverId;
  const gap = c?.mine && t ? c.mine.time - t.time : null;
  const where = (s: SectorTime) =>
    `${s.lap != null ? `lap ${s.lap}` : "an unnumbered lap"}${s.startedAt ? ` · ${fmtWhen(s.startedAt)}` : ""}`;

  const btn =
    "inline-flex items-center gap-1.5 rounded border border-helios-line bg-helios-panel px-2.5 py-1 text-xs transition " +
    "hover:border-asu-gold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-helios-line";

  return (
    <div
      role="region"
      aria-label={mode === "record" ? `${label} record` : `Your ${label}`}
      data-testid="sector-card"
      className="border-t border-helios-line bg-helios-line/15 px-5 py-3 text-xs"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {mode === "own" && n > 1 && (
            <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Sector">
              {Array.from({ length: n }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={i === sector}
                  onClick={() => onPickSector(i)}
                  className={
                    "rounded border px-2 py-0.5 font-mono text-[11px] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
                    (i === sector
                      ? "border-asu-gold bg-asu-gold/15 text-helios-text"
                      : "border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text")
                  }
                >
                  S{i + 1}
                </button>
              ))}
            </div>
          )}
          {!c || !t ? (
            <p className="text-helios-dim">No clean time in {label} yet.</p>
          ) : (
            <>
              <p data-testid="sector-card-target">
                <span className="font-medium">{mode === "record" ? `${label} record` : `Your best ${label}`}</span>{" "}
                <span className="font-mono text-asu-gold">{sectorText(t)}</span>
                <span className="text-helios-dim">
                  {" — "}
                  {mode === "record" ? `${yours ? "you" : t.driver}, ` : ""}
                  {where(t)}
                </span>
              </p>
              <p className="mt-0.5" data-testid="sector-card-mine">
                {c.mine ? (
                  <>
                    <span className="text-helios-dim">{c.mineLabel}</span>{" "}
                    <span className="font-mono">{sectorText(c.mine)}</span>
                    {gap != null && gap > 0.0005 && (
                      <span className="ml-1 font-mono text-helios-danger">({fmtGap(gap)})</span>
                    )}
                    {gap != null && gap <= 0.0005 && (
                      <span className="ml-1 text-helios-success">
                        {mode === "record" ? "— the record is yours" : "— driven on your best lap"}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-helios-dim">
                    {!driverId
                      ? "Sign in to compare it with your own laps."
                      : mode === "record"
                        ? `You have no clean ${label} on this course yet.`
                        : `Your best lap has no clean ${label} to compare.`}
                  </span>
                )}
              </p>
              {c.against && (
                <p className="mt-1 text-[11px] text-helios-muted">
                  Beside {c.against.label}{c.against.lap != null ? `, lap ${c.against.lap}` : ""}.
                </p>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded p-0.5 text-helios-dim transition hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* The reason sits on a wrapper too: a disabled button fires no
            pointer events, so its own title would never show. */}
        <span title={watchBlocked ?? `Watch ${label} in the simulator${c?.against ? ", your lap as the ghost" : ""}`}>
          <button
            type="button"
            className={btn}
            disabled={!!watchBlocked}
            aria-describedby={watchBlocked ? "sector-card-why" : undefined}
            onClick={() => c && onWatch?.(c)}
          >
            <IconMovie size={14} /> Watch in sim
          </button>
        </span>
        <span title={compareBlocked ?? `Open both laps in Logs, zoomed to ${label}`}>
          <button
            type="button"
            className={btn}
            disabled={!!compareBlocked}
            aria-describedby={compareBlocked ? "sector-card-why" : undefined}
            onClick={() => c && onCompare?.(c)}
          >
            <IconChartLine size={14} /> Compare in Logs
          </button>
        </span>
        {c && (watchBlocked || compareBlocked) && (
          <span id="sector-card-why" data-testid="sector-card-why" className="text-[11px] text-helios-muted">
            {compareBlocked ?? watchBlocked}
          </span>
        )}
      </div>
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
