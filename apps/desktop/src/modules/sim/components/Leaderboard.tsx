import { Fragment, useEffect, useMemo, useState } from "react";
import {
  IconChartLine, IconCloudOff, IconLoader2, IconLogin, IconMovie, IconStopwatch, IconTrendingUp, IconTrophy, IconX,
} from "@tabler/icons-react";
import { EmptyState } from "../../../components/EmptyState";
import {
  fmtGap, fmtTime, fmtWhen, hasTelemetry, parseGeneratedId, physicsEraOf, setupItems, unrankedReason,
  vehicleModelOf, VEHICLE_MODELS, type SimRun, type VehicleModel,
} from "../api";
import {
  bestWatchable, boardLabel, buildActivity, buildBoards, buildConsistencyBoards, buildImprovements, buildRecentRecords,
  compareOwnSector, compareRecord, courseName,
  CONSISTENCY_MIN_RUNS, CONSISTENCY_WINDOW,
  type ConsistencyBoard, type DriverEntry, type RecordEvent, type SectorComparison, type SectorTime, type TrackBoard,
} from "../lib/leaderboard";
import { DEVICE_CLASSES, deviceClass, type DeviceClass } from "../api";
import { isPending, type Pending } from "./pending";

interface Props {
  runs: SimRun[];
  canReplay: boolean;
  /** Open a run in the detail panel beside the board. */
  onOpenRun: (runId: string) => void;
  onReplayRun: (runId: string) => void;
  /** Drive against this run's best lap (the live delta's reference). */
  onChaseRun?: (runId: string) => void;
  /** Open `runId`'s best lap in Logs as Main, `againstId`'s as Ref. */
  onCompareRuns?: (runId: string, againstId: string, tag: string) => void;
  /** The run open in the detail panel, so its row can say so. */
  selectedId?: string | null;
  /** The detail panel is open beside the board: one board per row. */
  compact?: boolean;
  /** A button waiting on a download, so it can say so. */
  pending?: Pending | null;
  /** Whether team times are in the list at all. */
  teamState?: "ok" | "offline" | "signed-out";
  onSignIn?: () => void;
  /** The signed-in driver, whose laps a sector is compared with. */
  driverId?: string | null;
  /** Watch a sector in the simulator, the driver's own lap as the ghost. */
  onWatchSector?: (c: SectorComparison) => void;
  /** Open the sector's lap and the driver's own in Logs, side by side. */
  onCompareSector?: (c: SectorComparison) => void;
  /** Drive this course on this car model ("Launch 4-wheel"). */
  onLaunchCourse?: (track: string, model: VehicleModel) => void;
}

/** Which sector card is open: a team record, or the driver's own sectors. */
type OpenCard = { track: string; model: VehicleModel; mode: "record" | "own"; sector: number } | null;

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
  runs: allRuns, canReplay, onOpenRun, onReplayRun, onChaseRun, onCompareRuns,
  selectedId = null, compact = false, pending = null, teamState = "ok", onSignIn,
  driverId = null, onWatchSector, onCompareSector, onLaunchCourse,
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
  /**
   * The bicycle and the 4-wheel beta are different cars, so each has its own
   * board on every course -- side by side, not a tab away, because the point
   * of having both is to look across at the other one. Built per model from
   * the same filtered runs; a run from before simulator 0.7.2 is a bicycle
   * run (`vehicleModelOf`).
   */
  /**
   * And each course x model board is per PHYSICS ERA (`physicsEraOf`). A
   * model's current era is the newest any run of it has been driven in, on
   * any course -- a physics update starts a fresh board everywhere -- and a
   * course's older eras stay one click away above that course's board, not
   * wiped. The pick is per course: looking back at one board leaves the
   * others alone.
   */
  const [eraPick, setEraPick] = useState<Record<string, number>>({});
  const perModel = useMemo(() => VEHICLE_MODELS.map((m) => {
    const all = shown.filter((r) => vehicleModelOf(r) === m.id);
    return { model: m, all, current: Math.max(1, ...all.map(physicsEraOf)) };
  }), [shown]);
  /** Courses in activity order across both models. */
  const courseOrder = useMemo(() => {
    const score = new Map<string, { name: string; runs: number }>();
    for (const r of shown) {
      const cur = score.get(r.track) ?? { name: r.trackName, runs: 0 };
      cur.runs += 1;
      score.set(r.track, cur);
    }
    return [...score.entries()]
      .sort((a, b) => b[1].runs - a[1].runs || a[1].name.localeCompare(b[1].name))
      .map(([track, v]) => ({ track, trackName: v.name }));
  }, [shown]);
  /** One board per course x model, at the era being looked at. */
  const cells = useMemo(() => {
    const out = new Map<string, BoardCell>();
    for (const { track } of courseOrder) {
      for (const pm of perModel) {
        const here = pm.all.filter((r) => r.track === track);
        const eras = [...new Set([pm.current, ...here.map(physicsEraOf)])].sort((a, b) => b - a);
        const pick = eraPick[`${track}:${pm.model.id}`];
        const era = pick != null && eras.includes(pick) ? pick : pm.current;
        const runs = here.filter((r) => physicsEraOf(r) === era);
        out.set(`${track}:${pm.model.id}`, {
          eras, era, current: pm.current, runs, modelRuns: pm.all.length,
          board: buildBoards(runs)[0] ?? null,
          consistency: buildConsistencyBoards(runs)[0] ?? null,
          whyNot: whyNotRanked(runs),
        });
      }
    }
    return out;
  }, [courseOrder, perModel, eraPick]);
  /**
   * Two ways to rank the same runs. "Fastest" is the lap where everything
   * came together; "Average" is each driver's mean over their last
   * `CONSISTENCY_WINDOW` clean runs, which is the number an autocross with two
   * runs a driver actually pays for. The choice is per page, not per course:
   * a person comparing two courses wants the same rule on both.
   */
  const [mode, setMode] = useState<"fastest" | "average">("fastest");
  const improvements = useMemo(() => buildImprovements(shown), [shown]);
  const activity = useMemo(() => buildActivity(shown), [shown]);
  const records = useMemo(() => buildRecentRecords(shown, 6), [shown]);

  /** A board row as a keyboard reaches it: focusable, Enter opens the run. */
  const rowKeys = (runId: string) => ({
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      onOpenRun(runId);
    },
  });
  /** The row tint: yours is marked, the open one more strongly. */
  const rowTint = (e: { driverId: string; runId: string }) =>
    e.runId === selectedId
      ? " bg-asu-gold/15"
      : driverId && e.driverId === driverId
        ? " bg-asu-gold/[0.07] shadow-[inset_2px_0_0_0_rgb(var(--asu-gold)/0.8)]"
        : "";

  /**
   * The Chase and Compare buttons on a board row.
   *
   * Chase drives against that lap. Compare puts it beside yours in Logs --
   * your best on the same board -- or, on your own row, beside the leader's.
   */
  const rowActions = (b: TrackBoard, e: DriverEntry, mruns: SimRun[]) => {
    const run = mruns.find((r) => r.runId === e.runId);
    const own = !!driverId && e.driverId === driverId;
    const lapHere = !!run && hasTelemetry(run);
    const noLap = run?.remote
      ? `${e.driver} shared this time, not the lap itself`
      : "This lap's telemetry is not stored";
    const leaderRun = b.entries[0] && b.entries[0].runId !== e.runId
      ? mruns.find((r) => r.runId === b.entries[0]!.runId) ?? null
      : null;
    const against = own
      ? (leaderRun && hasTelemetry(leaderRun) ? leaderRun : null)
      : run && driverId ? bestWatchable(mruns, run, driverId) : null;
    const chaseWhy = !driverId ? "Sign in to Helios to start a run"
      : !lapHere ? noLap
      : !canReplay ? "The simulator is not installed here"
      : null;
    const compareWhy = !lapHere ? noLap
      : !driverId ? "Sign in to compare it with your own laps"
      : !against
        ? own
          ? e.rank === 1 ? "You hold the record: there is nothing quicker to compare with" : "The leader's lap is not stored, so there is nothing to compare with"
          : "You have no lap with telemetry on this board to compare with"
        : null;
    const busy = isPending(pending, e.runId);
    return (
      <>
        {onChaseRun && (
          <IconAction
            label={chaseWhy ?? `Drive against ${own ? "your" : `${e.driver}'s`} ${fmtTime(e.best)}`}
            disabled={!!chaseWhy || busy}
            busy={isPending(pending, e.runId, "chase")}
            onClick={() => onChaseRun(e.runId)}
          >
            <IconStopwatch size={14} />
          </IconAction>
        )}
        {onCompareRuns && (
          <IconAction
            label={compareWhy ?? (own
              ? `Compare your best with the leader's in Logs`
              : `Compare ${e.driver}'s lap with your best in Logs`)}
            disabled={!!compareWhy || busy}
            busy={isPending(pending, e.runId, "compare")}
            onClick={() => against && onCompareRuns(e.runId, against.runId, own ? "leader" : "my PB")}
          >
            <IconChartLine size={14} />
          </IconAction>
        )}
      </>
    );
  };

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

  /** A small "you" beside the viewer's own name, so the tint is not the only cue. */
  const you = (id: string) => (driverId && id === driverId
    ? <span className="ml-1.5 rounded bg-asu-gold/20 px-1 align-middle text-[10px] font-normal text-asu-gold">you</span>
    : null);

  const renderAverage = (b: ConsistencyBoard, modelName: string, whyNot: string) => (
        <section className="rounded-lg border border-helios-line bg-helios-panel">
          <header className="flex items-baseline justify-between border-b border-helios-line px-5 py-3">
            <h3 className="text-sm font-semibold">{modelName}</h3>
            <span className="text-[11px] text-helios-muted">
              {b.runCount} ranked run{b.runCount === 1 ? "" : "s"}
              {b.unrankedCount > 0 && (
                <span title={whyNot} className="cursor-help underline decoration-dotted underline-offset-2">
                  {` · ${b.unrankedCount} not ranked`}
                </span>
              )}
            </span>
          </header>

          {b.entries.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-helios-dim">
              Nobody has {CONSISTENCY_MIN_RUNS} clean ranked runs on this course yet, so there is no
              average to rank. Drive it a few more times and this fills in.
            </p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-helios-muted">
                  <th className="px-5 py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Driver</th>
                  <th className="px-2 py-2 text-right font-medium" title={`Mean scored lap over the newest ${CONSISTENCY_WINDOW} clean runs`}>
                    Average
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Gap</th>
                  <th className="px-2 py-2 text-right font-medium" title="Standard deviation of those laps: how far a typical run sits from the average">
                    Spread
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title="The quickest lap inside the window">
                    Best
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title={`Runs in the average, out of the ${CONSISTENCY_WINDOW} the window holds`}>
                    Runs
                  </th>
                  <th className="hidden py-2 pl-3 font-medium 2xl:table-cell">Latest</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {b.entries.map((e) => (
                  <tr
                    key={e.driverId}
                    className={"cursor-pointer border-t border-helios-line/60 transition hover:bg-helios-line/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold" + rowTint(e)}
                    onClick={() => onOpenRun(e.runId)}
                    {...rowKeys(e.runId)}
                  >
                    <td className="px-5 py-2 font-mono text-helios-dim">{e.rank}</td>
                    <td className="whitespace-nowrap py-2 font-medium">{e.driver}{you(e.driverId)}</td>
                    <td className={"px-2 py-2 text-right font-mono " + (e.rank === 1 ? "text-asu-gold" : "")}>
                      {fmtTime(e.average)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">
                      {e.rank === 1 ? "" : fmtGap(e.gap)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">±{e.spread.toFixed(3)}</td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">{fmtTime(e.best)}</td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim" data-testid="counted">
                      {e.counted}<span className="text-helios-muted">/{CONSISTENCY_WINDOW}</span>
                    </td>
                    <td className="hidden whitespace-nowrap py-2 pl-3 text-helios-dim 2xl:table-cell">{fmtWhen(e.latest)}</td>
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
            </table></div>
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
      
  );

  const renderFastest = (b: TrackBoard, model: VehicleModel, modelName: string, mruns: SimRun[], whyNot: string) => (
        <section className="rounded-lg border border-helios-line bg-helios-panel">
          <header className="flex items-baseline justify-between border-b border-helios-line px-5 py-3">
            <h3 className="text-sm font-semibold">{modelName}</h3>
            <span className="text-[11px] text-helios-muted">
              {b.runCount} ranked run{b.runCount === 1 ? "" : "s"}
              {b.unrankedCount > 0 && (
                <span title={whyNot} className="cursor-help underline decoration-dotted underline-offset-2">
                  {` · ${b.unrankedCount} not ranked`}
                </span>
              )}
            </span>
          </header>

          {b.entries.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-helios-dim">
              Nothing ranked here yet{whyNot ? ` (${whyNot})` : ""}. Launch from the
              Launch tab while signed in, on an unmodified car, and the time counts.
            </p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-helios-muted">
                  <th className="px-5 py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Driver</th>
                  <th className="px-2 py-2 text-right font-medium">Best</th>
                  <th className="px-2 py-2 text-right font-medium">Gap</th>
                  <th
                    className="px-2 py-2 text-right font-medium"
                    title="That same lap before penalties — the gap to Best is what the cones cost"
                  >
                    Raw
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title="Their own quickest sectors added up">
                    Theoretical
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Runs</th>
                  <th className="hidden py-2 pl-2 font-medium 2xl:table-cell">Set</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {b.entries.map((e) => {
                  const hasSetup = setupItems(e.setup, model).length > 0;
                  return (
                  <Fragment key={e.driverId}>
                  <tr
                    className={"group cursor-pointer border-t border-helios-line/60 transition hover:bg-helios-line/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold" + rowTint(e)}
                    onClick={() => onOpenRun(e.runId)}
                    {...rowKeys(e.runId)}
                  >
                    <td className={"px-5 font-mono text-helios-dim " + (hasSetup ? "pt-2" : "py-2")}>{e.rank}</td>
                    <td className={"whitespace-nowrap font-medium " + (hasSetup ? "pt-2" : "py-2")}>{e.driver}{you(e.driverId)}</td>
                    <td className={"px-2 py-2 text-right font-mono " + (e.rank === 1 ? "text-asu-gold" : "")}>
                      {fmtTime(e.best)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">
                      {e.rank === 1 ? "" : fmtGap(e.gap)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">{fmtTime(e.bestRaw)}</td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">
                      {/* Your own row only: where your perfect lap beats your
                          real one, sector by sector. */}
                      {driverId && e.driverId === driverId && honest(e.theoretical, e.best) != null ? (
                        <button
                          type="button"
                          aria-expanded={card?.track === b.track && card.model === model && card.mode === "own"}
                          title="Your best sectors against your best lap: where the perfect lap beats the real one"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const open = card?.track === b.track && card.model === model && card.mode === "own";
                            setCard(open ? null : { track: b.track, model, mode: "own", sector: biggestGain(b, e.driverId, mruns) });
                          }}
                          className="rounded px-1 underline decoration-dotted underline-offset-2 transition hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
                        >
                          {fmtTime(e.theoretical)}
                        </button>
                      ) : fmtTime(honest(e.theoretical, e.best))}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-helios-dim">{e.runs}</td>
                    <td className="hidden whitespace-nowrap py-2 pl-2 text-helios-dim 2xl:table-cell">{fmtWhen(e.when)}</td>
                    <td className="px-5 py-2 text-right">
                      <span className="inline-flex gap-1" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
                        <IconAction
                          label={canReplay ? "Watch that lap" : "The simulator is not installed here"}
                          disabled={!canReplay || isPending(pending, e.runId)}
                          busy={isPending(pending, e.runId, "replay")}
                          onClick={() => onReplayRun(e.runId)}
                        >
                          <IconMovie size={14} />
                        </IconAction>
                        {rowActions(b, e, mruns)}
                      </span>
                    </td>
                  </tr>
                  {hasSetup && (
                    <tr className={"cursor-pointer transition hover:bg-helios-line/25" + rowTint(e)} onClick={() => onOpenRun(e.runId)}>
                      <td />
                      <td colSpan={8} className="pb-2 pr-5">
                        <SetupLine setup={e.setup} model={model} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table></div>
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
                const open = card?.track === b.track && card.model === model && card.mode === "record" && card.sector === i;
                return (
                  <button
                    key={i}
                    type="button"
                    aria-expanded={open}
                    aria-label={`Sector ${i + 1} record ${s.time.toFixed(3)} seconds by ${s.driver}`}
                    title={`${s.driver}${s.lap != null ? `, lap ${s.lap}` : ""}${s.cones ? ` · incl. ${coneText(s.cones)}` : ""}`}
                    onClick={() => setCard(open ? null : { track: b.track, model, mode: "record", sector: i })}
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
              {honest(b.teamTheoretical, b.entries[0]?.best ?? null) != null && (
                <span className="ml-auto font-mono text-asu-gold" title="Every sector at its record, added up">
                  Perfect lap {fmtTime(b.teamTheoretical)}
                </span>
              )}
            </div>
          )}

          {card?.track === b.track && card.model === model && (
            <SectorCard
              key={`${card.mode}-${card.sector}`}
              board={b}
              runs={mruns}
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
      
  );

  // Said above everything else: a board that is only this machine's runs looks
  // exactly like a team board nobody has beaten you on.
  const localOnly = teamState !== "ok" && (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-helios-warn/30 bg-helios-warn/10 px-4 py-2 text-xs text-helios-warn"
      data-testid="board-local-only"
    >
      {teamState === "signed-out" ? <IconLogin size={15} className="shrink-0" /> : <IconCloudOff size={15} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        Showing this machine&rsquo;s runs only &mdash;{" "}
        {teamState === "signed-out"
          ? "sign in for team times."
          : "offline. Team times come back when this machine reconnects."}
      </span>
      {teamState === "signed-out" && onSignIn && (
        <button
          type="button"
          className="shrink-0 rounded bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-on-gold transition hover:brightness-110"
          onClick={onSignIn}
        >
          Sign in
        </button>
      )}
    </div>
  );

  if (runs.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-5 p-6">
        {localOnly}
        {scopeTabs}
        <EmptyState
          Icon={IconTrophy}
          title="No runs yet"
          hint="The board fills itself the first time somebody drives."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-5 p-6">
      {localOnly}
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

      {/* The newest records and personal bests, each on its own board. This
          replaced "the best lap anyone has scored", one time picked across
          every course, car model and physics era -- a comparison between
          laps that do not compare. */}
      {records.length > 0 && (
        <RecentRecords
          records={records}
          driverId={driverId}
          selectedId={selectedId}
          showEra={perModel.some((pm) => pm.current > 1)}
          onOpen={onOpenRun}
        />
      )}

      {courseOrder.map(({ track, trackName }) => (
        <div key={`${mode}-${track}`} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-helios-text">{trackName}</h2>
          {/* One board per row while the run panel is open beside the page:
              two side by side in what is left beside it are too narrow to read. */}
          <div className={"grid items-start gap-3 " + (compact ? "" : "xl:grid-cols-2")}>
            {perModel.map(({ model: m }) => {
              const model = m.id;
              const modelName = m.name;
              const cell = cells.get(`${track}:${model}`)!;
              const { eras, era, current, runs: mruns, whyNot } = cell;
              // A generated course is one board per seed; a model nobody has
              // driven on this tab would put an identical empty card beside
              // every one of them.
              if (scope === "generated" && cell.modelRuns === 0) return null;
              // The 4-wheel beta is new and its board is thin: a one-click way
              // onto it, on the course being looked at.
              const launch = model === 3 && onLaunchCourse ? (
                <button
                  type="button"
                  onClick={() => onLaunchCourse(track, 3)}
                  title={`Drive ${trackName} on the 4-wheel model with your launcher settings`}
                  className="mb-1.5 ml-auto rounded border border-asu-gold/60 bg-asu-gold/10 px-2.5 py-0.5 text-[11px] text-helios-text transition hover:bg-asu-gold/20"
                >
                  Launch 4-wheel
                </button>
              ) : null;
              const eraBar = eras.length > 1 && (
                <EraBar
                  eras={eras} era={era} current={current}
                  onPick={(e) => setEraPick((p) => ({ ...p, [`${track}:${model}`]: e }))}
                />
              );
              if (mode === "average") {
                const b = cell.consistency;
                return b
                  ? <div key={model}><div className="flex min-h-7 items-start gap-2">{eraBar}{launch}</div>{renderAverage(b, modelName, whyNot)}</div>
                  : <div key={model}><div className="flex min-h-7 items-start gap-2">{eraBar}{launch}</div><EmptyBoard modelName={modelName} detail={m.detail} eraNote={era !== current ? "past" : eras.length > 1 ? "fresh" : null} /></div>;
              }
              const b = cell.board;
              return b
                ? <div key={model}><div className="flex min-h-7 items-start gap-2">{eraBar}{launch}</div>{renderFastest(b, model, modelName, mruns, whyNot)}</div>
                : <div key={model}><div className="flex min-h-7 items-start gap-2">{eraBar}{launch}</div><EmptyBoard modelName={modelName} detail={m.detail} eraNote={era !== current ? "past" : eras.length > 1 ? "fresh" : null} /></div>;
            })}
          </div>
        </div>
      ))}

      {improvements.length > 0 && (
        <section className="rounded-lg border border-helios-line bg-helios-panel">
          <header className="flex items-center gap-2 border-b border-helios-line px-5 py-3">
            <IconTrendingUp size={16} className="text-helios-success" />
            <h3 className="text-sm font-semibold">Time found</h3>
            <span className="text-[11px] text-helios-muted">
              since each driver's first run on a course, per car model
            </span>
          </header>
          <table className="w-full border-collapse text-xs">
            <tbody>
              {improvements.slice(0, 12).map((im) => (
                <tr key={`${im.driverId}-${im.track}-${im.model}-${im.era}`} className="border-t border-helios-line/60">
                  <td className="px-5 py-2 font-medium">{im.driver}{you(im.driverId)}</td>
                  {/* Which board: a driver can have found time on the bicycle
                      and on the 4-wheel on the same course, and two unlabelled
                      rows for one name and one course read as a mistake. */}
                  <td className="py-2 text-helios-dim">
                    {courseName(im.track)}
                    <span className="text-helios-muted">
                      {" · "}{VEHICLE_MODELS.find((m) => m.id === im.model)?.name ?? `model ${im.model}`}
                      {perModel.some((pm) => pm.current > 1) ? ` · rev ${im.era}` : ""}
                    </span>
                  </td>
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

/** The setup a time was set on, one short line under the driver's name. */
function SetupLine({ setup, model }: { setup: Record<string, number> | null; model: VehicleModel }) {
  const items = setupItems(setup, model);
  if (items.length === 0) return null;
  return (
    <div
      className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] font-normal text-helios-muted"
      data-testid="setup-line"
    >
      {items.map((it) => (
        <span key={it.label} title={it.title} className="whitespace-nowrap">
          <span className="text-helios-dim">{it.label}</span> {it.value}
        </span>
      ))}
    </div>
  );
}

/** A model with no ranked time on this course yet, so the pair still lines up. */
function EmptyBoard({ modelName, detail, eraNote }: {
  modelName: string; detail: string;
  /** "fresh": the current physics, with earlier physics' times to look at;
   *  "past": an earlier physics nobody drove this course on. */
  eraNote?: "fresh" | "past" | null;
}) {
  return (
    <section className="rounded-lg border border-dashed border-helios-line bg-helios-panel/50">
      <header className="flex items-baseline justify-between border-b border-helios-line/60 px-5 py-3">
        <h3 className="text-sm font-semibold text-helios-dim">{modelName}</h3>
        <span className="text-[11px] text-helios-muted">{detail}</span>
      </header>
      <p className="px-5 py-6 text-center text-xs text-helios-dim">
        {eraNote === "fresh"
          ? "No times on this course with the current physics yet. Earlier physics' times are one click away above."
          : eraNote === "past"
          ? "Nobody drove this course on that physics."
          : "No times on this model here yet. Pick it on the simulator's staging card (simulator 0.7.2 or newer) and the board fills itself."}
      </p>
    </section>
  );
}

/**
 * The physics eras a model's board has, newest first. Only shown when there
 * is more than one: a physics update starts a new board and keeps the old.
 */
function EraBar({ eras, era, current, onPick }: {
  eras: number[]; era: number; current: number; onPick: (e: number) => void;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1" role="group" aria-label="Physics era">
      <span className="mr-1 text-[10px] uppercase tracking-wider text-helios-muted">Physics</span>
      {eras.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          aria-pressed={e === era}
          title={e === current
            ? "The current physics. Times from older physics sit on their own board."
            : "An earlier revision of this model's physics: times set then, kept for the record."}
          className={
            "rounded border px-2 py-0.5 text-[11px] transition " +
            (e === era
              ? "border-asu-gold bg-asu-gold/15 text-helios-text"
              : "border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text")
          }
        >
          rev {e}{e === current ? " (current)" : ""}
        </button>
      ))}
    </div>
  );
}

/** A course x model board at one physics era. */
interface BoardCell {
  eras: number[];
  era: number;
  current: number;
  runs: SimRun[];
  /** Runs of this model anywhere on the tab, any era. */
  modelRuns: number;
  board: TrackBoard | null;
  consistency: ConsistencyBoard | null;
  whyNot: string;
}

/** "14 runs: the car was modified ...; 2 runs: ...": why a board's runs are not ranked. */
function whyNotRanked(runs: SimRun[]): string {
  const tally = new Map<string, number>();
  for (const r of runs) {
    const why = unrankedReason(r);
    if (why) tally.set(why, (tally.get(why) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} run${n === 1 ? "" : "s"}: ${why}`)
    .join("; ");
}

/**
 * A theoretical best slower than a lap actually driven is missing sectors,
 * not a perfect lap: a shared lap whose per-sector cones were lost (Helios
 * before 5.12.2) gives up all its sectors. Shown as a dash until the run is
 * re-shared with them.
 */
function honest(theoretical: number | null, best: number | null): number | null {
  return theoretical != null && best != null && theoretical > best + 0.002 ? null : theoretical;
}

/** A square icon button on a board row, with a spinner while it works. */
function IconAction({
  label, disabled, busy, onClick, children,
}: { label: string; disabled?: boolean; busy?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={busy ? "Working…" : label}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled && !busy}
      onClick={() => { if (!busy) onClick(); }}
      className="rounded border border-helios-line p-1 text-helios-dim transition hover:border-asu-gold hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-30"
    >
      {busy ? <IconLoader2 size={14} className="animate-spin text-asu-gold" /> : children}
    </button>
  );
}

/** Within this long of now, a record wears a NEW badge. */
const NEW_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * The latest team records and personal bests, one card each, newest first.
 * Each says which board it was set on, what it beat and by how much.
 */
function RecentRecords({
  records, driverId, selectedId, showEra, onOpen,
}: {
  records: RecordEvent[];
  driverId: string | null;
  selectedId: string | null;
  showEra: boolean;
  onOpen: (runId: string) => void;
}) {
  const now = Date.now();
  return (
    <section className="rounded-lg border border-helios-line bg-helios-panel" data-testid="recent-records">
      <header className="flex flex-wrap items-center gap-x-2 border-b border-helios-line px-5 py-2.5">
        <IconTrophy size={16} className="shrink-0 text-asu-gold" />
        <h3
          className="text-sm font-semibold"
          title="Team records and personal bests, each on its own board (course, car model, device, physics). Times are SCORED: raw time plus two seconds a cone. A lap that went off course has no time here, stricter than FSAE's +20 s, on purpose."
        >
          Recent records
        </h3>
        <span className="text-[11px] text-helios-muted">team records and personal bests, each on its own board</span>
      </header>
      <div className="grid gap-px bg-helios-line sm:grid-cols-2 2xl:grid-cols-3">
        {records.map((ev) => {
          const fresh = now - Date.parse(ev.at) < NEW_FOR_MS;
          const yours = !!driverId && ev.driverId === driverId;
          return (
            <button
              key={`${ev.runId}-${ev.kind}`}
              type="button"
              onClick={() => onOpen(ev.runId)}
              className={
                "flex min-w-0 items-center gap-3 px-4 py-2.5 text-left text-xs transition hover:bg-helios-line/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold " +
                (ev.runId === selectedId ? "bg-asu-gold/15" : "bg-helios-panel")
              }
            >
              <span
                className={
                  "w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider " +
                  (ev.kind === "record" ? "bg-asu-gold/20 text-asu-gold" : "bg-helios-line text-helios-dim")
                }
              >
                {ev.kind === "record" ? "Record" : "PB"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold text-helios-text">{fmtTime(ev.time)}</span>
                  <span className="truncate font-medium">{yours ? "You" : ev.driver}</span>
                  {fresh && (
                    <span className="shrink-0 rounded bg-helios-success/20 px-1 text-[10px] font-semibold text-helios-success">NEW</span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-helios-muted">
                  {boardLabel(ev.key, { era: showEra })}
                  {" · "}
                  {ev.previous != null
                    ? <span className="font-mono text-helios-success">{fmtGap(ev.time - ev.previous)}</span>
                    : "first time on this board"}
                  {" · "}
                  {fmtWhen(ev.at)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
