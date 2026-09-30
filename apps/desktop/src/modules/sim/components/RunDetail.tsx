import { useEffect, useMemo, useState } from "react";
import {
  IconChartLine, IconFolderOpen, IconLoader2, IconMovie, IconStopwatch, IconTrash, IconX,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import {
  VEHICLE_MODELS, finishedText, fmtBytes, fmtGap, fmtTime, fmtWhen, hasTelemetry, isRankable, parseGeneratedId,
  runBest, runTheoretical, simDeleteRun, simReadRun, unrankedReason, vehicleModelOf,
  type SimManifest, type SimRun,
} from "../api";
import {
  bestWatchable, boardLabel, boardStanding, ghostCandidates, lapCounts, leaderWatchable,
} from "../lib/leaderboard";
import { GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT } from "../lib/share";
import { isPending, type Pending } from "./pending";

/**
 * What this run's course costs to keep.
 *
 * The rule is two rules -- a generated course is bounded more tightly than a
 * fixed one -- and this panel is where a driver asks "why is my lap not up
 * there". Printing the fixed numbers on a generated run would answer the
 * question wrongly, which is worse than not answering it.
 */
function limitsFor(track: string): { best: number; recent: number; kind: string } {
  return parseGeneratedId(track) !== null
    ? { best: GEN_KEEP_BEST, recent: GEN_KEEP_RECENT, kind: "generated course" }
    : { best: KEEP_BEST, recent: KEEP_RECENT, kind: "course" };
}

/** Which lap the live delta counts against when "Drive against" is pressed. */
type Reference = "this" | "pb" | "leader";

interface Props {
  run: SimRun;
  /** Every run, so the ghost picker can offer the ones on this course. */
  allRuns: SimRun[];
  canReplay: boolean;
  /** The signed-in account, or null. Null means replays are fine and driving
   *  is not; the id itself says whether this run is the viewer's own, which
   *  is what decides whether it can be taken off the team's board. */
  driverId: string | null;
  /**
   * Whether this run's lap is in the team's copy right now, for a run of
   * the signed-in driver's own; null for anybody else's, where the row says.
   * The team keeps the lap for a driver's best `KEEP_BEST` and latest
   * `KEEP_RECENT` runs per fixed course, and `GEN_KEEP_BEST` / `GEN_KEEP_RECENT`
   * per generated one; the rest share their time only.
   */
  lapShared?: boolean | null;
  /** A button waiting on a download, so it can say so. */
  pending?: Pending | null;
  onClose: () => void;
  onReplay: (run: SimRun, ghostId: string | null) => void;
  onOpenInLogs: (run: SimRun) => void;
  /** Open this run's best lap in Logs as Main with `against`'s as Ref. */
  onCompareInLogs?: (run: SimRun, against: SimRun, tag: string) => void;
  /** Start a drive with `reference`'s best lap as the live delta's reference. */
  onChase: (reference: SimRun) => void;
  onDeleted: (runId: string) => void;
}

export function RunDetail({
  run, allRuns, canReplay, driverId, lapShared = null, pending = null,
  onClose, onReplay, onOpenInLogs, onCompareInLogs, onChase, onDeleted,
}: Props) {
  const canDrive = !!driverId;
  const mine = !!driverId && run.driverId === driverId;
  const [manifest, setManifest] = useState<SimManifest | null>(null);
  const [ghostId, setGhostId] = useState<string>("");
  const [reference, setReference] = useState<Reference>("this");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The full manifest carries the setup and the event list, which the listing
  // deliberately does not; it is read only when a run is actually opened.
  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setGhostId("");
    setReference("this");
    setConfirmDelete(false);
    setDeleted(false);
    // Cleared with the rest of it. A run whose `run.json` would not read left
    // its red line pinned under every healthy run opened afterwards, which
    // reads as "this run is broken too".
    setError(null);
    // A shared run has no `run.json` here to read. Asking anyway put "cannot
    // find the file specified" in red under every teammate's run, which
    // reads as the run being broken rather than as it being elsewhere.
    if (run.remote) return () => { cancelled = true; };
    simReadRun(run.runId)
      .then((d) => { if (!cancelled) setManifest(d.manifest); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [run.runId, run.remote]);

  // The viewer's own best first; signed out, the run's own driver's.
  const ghosts = useMemo(() => ghostCandidates(allRuns, run, driverId ?? run.driverId), [allRuns, run, driverId]);
  const ghostPbOf = driverId ?? run.driverId;
  const standing = useMemo(() => boardStanding(allRuns, run), [allRuns, run]);
  /** The viewer's best watchable lap on this run's board, and the leader's. */
  const myPb = useMemo(() => (driverId ? bestWatchable(allRuns, run, driverId) : null), [allRuns, run, driverId]);
  const leaderRun = useMemo(() => leaderWatchable(allRuns, run), [allRuns, run]);
  const best = runBest(run);
  // How many laps this run's course keeps. See `limitsFor`.
  const lim = limitsFor(run.track);
  const reason = unrankedReason(run);
  const st = run.stats;
  const busy = isPending(pending, run.runId);
  const whose = (id: string | null | undefined, name: string) => (driverId && id === driverId ? "your" : `${name}'s`);

  // The laps that set a time, and the quickest of them: what every gap in the
  // lap table is measured from. A lap that left the course has no time here
  // (stricter than FSAE's +20 s, on purpose -- see `bestLapWentOffCourse`),
  // so it is neither the best nor measured against it.
  const counting = run.laps.filter(lapCounts);
  const lapBest = counting.reduce<number | null>((b, l) => (b == null || l.total < b ? l.total : b), null);
  const bestLapNo = run.stats.bestLapNumber != null && counting.some((l) => l.lap === run.stats.bestLapNumber)
    ? run.stats.bestLapNumber
    : counting.find((l) => l.total === lapBest)?.lap ?? null;

  /** The run "Drive against" would use, and what the button should say. */
  const refRun = reference === "pb" ? myPb : reference === "leader" ? leaderRun : run;
  const refLabel = reference === "pb"
    ? "your PB"
    : reference === "leader"
      ? "the leader"
      : "this lap";
  const refBlocked = !refRun
    ? reference === "pb"
      ? "You have no ranked lap with telemetry on this board yet"
      : "The board leader's lap is not stored anywhere, so it cannot be chased"
    : runBest(refRun) == null
      ? "this run has no time to chase"
      : !hasTelemetry(refRun)
        ? refRun.remote
          ? `${refRun.driver} shared this run's time, not the lap itself`
          : "This run has no telemetry file to chase"
        : !canDrive
          ? "Sign in to Helios to start a run"
          : !canReplay
            ? "The simulator is not installed here"
            : null;

  // Setup: the manifest's full parameter set when the run is on this disk; a
  // shared run carries only the run-to-run setup its best lap was set on, and
  // that is still worth showing rather than nothing.
  const setup = manifest?.setup && Object.keys(manifest.setup).length > 0
    ? { values: manifest.setup, full: true }
    : run.stats.setup && Object.keys(run.stats.setup).length > 0
      ? { values: run.stats.setup, full: false }
      : null;

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-helios-line bg-helios-strip" aria-label={`Run: ${run.driver}, ${run.trackName}`}>
      <header className="flex items-start gap-2 border-b border-helios-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{run.driver}</h3>
          <p className="truncate text-xs text-helios-dim">
            {run.trackName} · {fmtWhen(run.startedAt)}
          </p>
          {run.session && <p className="truncate text-[11px] text-helios-muted">{run.session}</p>}
        </div>
        <button
          className="rounded p-1 text-helios-dim transition hover:text-helios-text"
          onClick={onClose}
          aria-label="Close"
        >
          <IconX size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Headline label="Best lap" value={fmtTime(best)} accent={!reason} />
          <Headline label="Theoretical" value={fmtTime(runTheoretical(run))} />
        </div>
        {reason && (
          <p className="mb-4 rounded border border-helios-warn/30 bg-helios-warn/10 px-3 py-2 text-[11px] text-helios-warn">
            Not ranked — {reason}.
          </p>
        )}

        {/* Which board this run is on, and where its driver stands there --
            the same board the Leaderboard tab draws, keyed the same way. */}
        <Group title="On the board">
          <Row label="Board" value={boardLabel(standing.key, { era: true })} />
          <Row
            label="Position"
            value={
              !isRankable(run)
                ? "not ranked"
                : standing.entry
                  ? `P${standing.entry.rank} of ${standing.board?.entries.length ?? 1}` +
                    (standing.entry.rank > 1 && standing.leader
                      ? ` · ${fmtGap(standing.entry.best - standing.leader.best)} to ${standing.leader.driverId === driverId ? "you" : standing.leader.driver}`
                      : " · the record")
                  : "—"
            }
            warn={!isRankable(run)}
            testId="board-position"
          />
          {isRankable(run) && standing.entry && !standing.isDriversBest && (
            <Row
              label="This run"
              value={`${fmtGap((best ?? 0) - standing.entry.best)} off ${whose(run.driverId, run.driver)} best`}
            />
          )}
        </Group>

        <Group title="The run">
          <Row label="Laps" value={String(st.laps)} />
          <Row label="Wheel time" value={`${st.durationS.toFixed(1)} s`} />
          <Row label="Distance" value={`${(st.distanceM / 1000).toFixed(2)} km`} />
          <Row label="Cones" value={String(st.totalCones)} warn={st.totalCones > 0} />
          <Row label="Off course" value={String(st.totalOffCourse)} warn={st.totalOffCourse > 0} />
          <Row label="Ended" value={finishedText(run.finishedReason)} title={run.finishedReason ?? undefined} />
        </Group>

        <Group title="What the car did">
          <Row label="Top speed" value={`${st.peakSpeedKph.toFixed(0)} km/h`} />
          <Row label="Peak lateral" value={`${st.peakLatG.toFixed(2)} g`} />
          <Row label="Peak braking" value={`${st.peakBrakeG.toFixed(2)} g`} />
          <Row label="Peak accel" value={`${st.peakAccelG.toFixed(2)} g`} />
          <Row label="Peak RPM" value={st.peakRpm.toFixed(0)} />
          <Row label="Full throttle" value={`${(st.fullThrottleFrac * 100).toFixed(0)}% of the run`} />
          <Row label="Braking" value={`${(st.brakingFrac * 100).toFixed(0)}% of the run`} />
          {st.ffbClippedFrac > 0.001 && (
            <Row
              label="FFB clipped"
              value={`${(st.ffbClippedFrac * 100).toFixed(1)}% of the run`}
              warn={st.ffbClippedFrac > 0.05}
            />
          )}
        </Group>

        {run.laps.length > 0 && (
          <Group title="Laps">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-helios-muted">
                  <th className="pb-1 font-medium">Lap</th>
                  <th className="pb-1 text-right font-medium">Time</th>
                  <th className="pb-1 text-right font-medium">Gap</th>
                  <th className="pb-1 pl-2 font-medium">Sectors</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {run.laps.map((l) => {
                  const counts = lapCounts(l);
                  // By lap number, not by comparing floats: two laps that tie
                  // would otherwise both light up.
                  const isBest = counts && l.lap === bestLapNo;
                  return (
                    <tr
                      key={l.lap}
                      className={"border-t border-helios-line/50 " + (counts ? "" : "text-helios-muted")}
                      data-testid={counts ? "lap-row" : "lap-row-off"}
                      title={counts ? undefined : "Went off course, so this lap sets no time"}
                    >
                      <td className="py-1">L{l.lap}</td>
                      <td className={"py-1 pl-2 text-right " + (isBest ? "text-asu-gold" : counts ? "" : "line-through")}>
                        {fmtTime(l.total)}
                      </td>
                      <td className="whitespace-nowrap py-1 pl-3 text-right text-helios-dim">
                        {!counts
                          ? <span className="font-sans text-helios-warn">off course</span>
                          : isBest || lapBest == null ? "—" : fmtGap(l.total - lapBest)}
                      </td>
                      <td className="py-1 pl-2 text-helios-dim">
                        {l.sectors.length ? l.sectors.map((s) => (s == null ? "—" : s.toFixed(2))).join(" / ") : "—"}
                        {l.cones > 0 && (
                          <span className="ml-1 font-sans text-helios-warn">{l.cones}c</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Group>
        )}

        <Group title="How it was driven">
          <Row label="Car" value={VEHICLE_MODELS.find((m) => m.id === vehicleModelOf(run))?.name ?? "—"} />
          <Row label="Controls" value={run.profile ?? "—"} />
          {run.device && <Row label="Device" value={run.device} />}
          <Row label="Physics" value={run.physics === "native-1khz" ? "native, 1 kHz" : run.physics ?? "—"} />
          <Row
            label="Driver aids"
            value={aidsText(run)}
            warn={run.assists.traction || run.assists.abs || run.assists.autoShift}
          />
          <Row label="Sim build" value={run.simVersion ?? "—"} />
          <Row
            label="Driver"
            value={run.driverId ? "signed in to Helios" : "unverified"}
            warn={!run.driverId}
          />
        </Group>

        <Group title="The log">
          {/* What the log ACHIEVED, not what the sampler was aiming for. 100 Hz
              is a ceiling: at most one row is written per simulation step, so
              a machine that cannot hold the frame rate logs at the frame rate,
              and telling an analyst it was 100 Hz when it was 55 is the kind
              of quiet wrong number this whole module exists to avoid. */}
          <Row
            label="Samples"
            value={
              // A shared row pushed before the count travelled has none, and
              // "0 at 99 Hz" is a wrong number, not a missing one.
              run.samples === 0
                ? "—"
                : run.sampleRateHz != null
                  ? `${run.samples.toLocaleString()} at ${run.sampleRateHz.toFixed(run.sampleRateHz >= 99 ? 0 : 1)} Hz`
                  : run.samples.toLocaleString()
            }
            warn={run.sampleRateHz != null && run.sampleRateHz < 90}
            title={
              run.sampleRateHz != null && run.sampleRateHz < 90
                ? "This run was logged below 100 Hz because the machine could not hold the frame rate"
                : undefined
            }
          />
          {/* The local byte count is zero for every shared run, because it
              is not here. What the panel can honestly say about one is whether
              the driver shared the lap or only its time. */}
          <Row
            label="Telemetry"
            value={
              run.remote
                ? run.telemetryObject
                  ? `${fmtBytes(run.telemetrySharedBytes ?? 0)} shared`
                  : "time only — the lap was not shared"
                : fmtBytes(run.telemetryBytes)
            }
          />
          {/* A run of your own says whether the team has the lap or only the
              time, and why: the rule is the driver's best few and latest few
              per course, and "why is my lap not up there" should not need a
              trip to the source. */}
          {!run.remote && lapShared != null && (
            <Row
              label="Shared"
              value={
                lapShared
                  ? `time and lap — one of your best ${lim.best} or latest ${lim.recent} on this ${lim.kind}`
                  : `time only — the lap is kept here; only your best ${lim.best} and latest ${lim.recent} per ${lim.kind} go up`
              }
              title={
                `Every run's time is shared with the team. The lap itself is uploaded for your best ${lim.best} and latest ${lim.recent} runs on this ${lim.kind}, and removed from the team's copy as newer or quicker ones replace it. Nothing is removed from this machine.`
              }
            />
          )}
          {manifest?.channels && <Row label="Channels" value={String(manifest.channels.length)} />}
          {manifest?.events && <Row label="Events" value={String(manifest.events.length)} />}
          {manifest?.truncated && (
            <Row label="Truncated" value="hit the sample limit" warn />
          )}
        </Group>

        {setup && <SetupBlock setup={setup.values} full={setup.full} />}

        {error && <p className="text-xs text-helios-danger">{error}</p>}
      </div>

      <footer className="border-t border-helios-line px-4 py-3">
        {ghosts.length > 0 && canReplay && (
          <label className="mb-2 block">
            {/* It only ever fed the replay: "Drive against" has its own
                reference below, and the label used to suggest otherwise. */}
            <span className="mb-1 block text-[11px] text-helios-dim">Ghost in replay</span>
            <select
              className="w-full rounded border border-helios-line bg-helios-deep px-2 py-1.5 text-xs outline-none focus:border-asu-gold"
              value={ghostId}
              aria-label="Ghost in replay"
              onChange={(e) => setGhostId(e.target.value)}
            >
              <option value="">No ghost</option>
              {ghosts.slice(0, 20).map((g, i) => (
                <option key={g.runId} value={g.runId}>
                  {ghostLabel(g, i === 0 && !!ghostPbOf && g.driverId === ghostPbOf, driverId)}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* Every "can this run be opened" decision below goes through
            `hasTelemetry`, the same rule the runs table uses, so the two
            cannot disagree about one run on one screen. The replay and the
            reference lap both need the telemetry -- the simulator builds its
            time-at-distance table from it -- so a shared run whose driver
            shared the time and not the lap can be neither watched nor chased,
            and a shared run whose lap IS up can be both: clicking fetches it
            first. */}
        <div className="flex gap-2">
          <button
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-asu-gold px-3 py-2 text-xs font-semibold text-helios-on-gold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canReplay || !hasTelemetry(run) || busy}
            aria-busy={isPending(pending, run.runId, "replay") || undefined}
            title={
              !canReplay
                ? "The simulator is not installed here"
                : !hasTelemetry(run)
                  ? run.remote
                    ? `${run.driver} shared this run's time, not the lap itself`
                    : "This run has no telemetry file to replay"
                  : run.remote
                    ? `Fetch ${run.driver}'s lap and watch it`
                    : undefined
            }
            onClick={() => onReplay(run, ghostId || null)}
          >
            {isPending(pending, run.runId, "replay") ? <Spinner /> : <IconMovie size={14} />} Watch replay
          </button>
          <button
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-helios-line px-3 py-2 text-xs transition hover:border-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasTelemetry(run) || busy}
            aria-busy={isPending(pending, run.runId, "logs") || undefined}
            title={
              !hasTelemetry(run)
                ? run.remote
                  ? `${run.driver} shared this run's time, not the lap itself`
                  : "This run has no telemetry file"
                : run.remote
                  ? `Fetch ${run.driver}'s lap and open it in Logs`
                  : "Open this run's best lap in Logs"
            }
            onClick={() => onOpenInLogs(run)}
          >
            {isPending(pending, run.runId, "logs") ? <Spinner /> : <IconChartLine size={14} />} Open in Logs
          </button>
        </div>
        {/* Side by side in Logs: this run's best lap as Main, a reference as
            Ref, in the lap-analysis workspace. Offered only where there is a
            different lap with telemetry to put beside it. */}
        {onCompareInLogs && hasTelemetry(run) && ((myPb && myPb.runId !== run.runId) || (leaderRun && leaderRun.runId !== run.runId)) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-helios-muted">Compare in Logs with</span>
            {myPb && myPb.runId !== run.runId && (
              <button
                type="button"
                className="rounded border border-helios-line px-2 py-1 transition hover:border-asu-gold disabled:opacity-40"
                disabled={busy}
                title={`This run's best lap as Main, your PB (${fmtTime(runBest(myPb))}) as Ref`}
                onClick={() => onCompareInLogs(run, myPb, "my PB")}
              >
                my PB {fmtTime(runBest(myPb))}
              </button>
            )}
            {leaderRun && leaderRun.runId !== run.runId && leaderRun.runId !== myPb?.runId && (
              <button
                type="button"
                className="rounded border border-helios-line px-2 py-1 transition hover:border-asu-gold disabled:opacity-40"
                disabled={busy}
                title={`This run's best lap as Main, the board leader's (${leaderRun.driver}, ${fmtTime(runBest(leaderRun))}) as Ref`}
                onClick={() => onCompareInLogs(run, leaderRun, "leader")}
              >
                leader {fmtTime(runBest(leaderRun))}
              </button>
            )}
            {isPending(pending, run.runId, "compare") && <Spinner />}
          </div>
        )}
        {/* "Drive against" picks its reference explicitly. It used to ignore
            the ghost picker above it while sitting right under it. */}
        <div className="mt-2 flex gap-2">
          <span className="flex-1" title={refBlocked ?? undefined}>
            <button
              className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-asu-gold/50 bg-asu-gold/10 px-3 py-2 text-xs font-medium text-asu-gold transition hover:bg-asu-gold/20 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!!refBlocked || busy}
              aria-busy={isPending(pending, refRun?.runId ?? "", "chase") || undefined}
              title={
                refBlocked ??
                (refRun!.remote
                  ? `Fetch ${refRun!.driver}'s lap and drive against it`
                  : `Start a drive with ${refLabel === "this lap" ? "this lap" : `${whose(refRun!.driverId, refRun!.driver)} ${fmtTime(runBest(refRun!))}`} as the live delta's reference`)
              }
              onClick={() => refRun && onChase(refRun)}
            >
              {isPending(pending, refRun?.runId ?? "", "chase") ? <Spinner /> : <IconStopwatch size={14} />}
              Drive against {refLabel}
            </button>
          </span>
          <select
            className="w-28 shrink-0 rounded border border-helios-line bg-helios-deep px-1.5 py-1 text-[11px] outline-none focus:border-asu-gold"
            aria-label="Reference lap for the live delta"
            title="Which lap the live delta counts against"
            value={reference}
            onChange={(e) => setReference(e.target.value as Reference)}
          >
            <option value="this">this lap</option>
            <option value="pb" disabled={!myPb}>my PB{myPb ? ` ${fmtTime(runBest(myPb))}` : ""}</option>
            <option value="leader" disabled={!leaderRun}>
              leader{leaderRun ? ` ${fmtTime(runBest(leaderRun))}` : ""}
            </option>
          </select>
        </div>
        <div className="mt-2 flex gap-2">
          {/* No files to show for a run that is not here. */}
          {!run.remote && (
            <button
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-helios-line px-3 py-1.5 text-[11px] text-helios-dim transition hover:border-asu-gold hover:text-helios-text"
              onClick={() => void invoke("reveal_in_explorer", { path: run.dir }).catch(() => {})}
            >
              <IconFolderOpen size={13} /> Show the files
            </button>
          )}
          {/* A local run can always be deleted from this disk. A run that is
              only on the board can be deleted only by its driver -- the
              server would refuse anybody else, so nobody else is offered it. */}
          {(!run.remote || mine) && (
            <button
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-helios-line px-3 py-1.5 text-[11px] text-helios-dim transition hover:border-helios-danger hover:text-helios-danger disabled:opacity-40"
              disabled={deleted}
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrash size={13} /> {deleted ? "Deleting…" : "Delete run"}
            </button>
          )}
        </div>
      </footer>
      {/* What "delete" will actually do, said before it is done. The button
          reads "for good" and for a while meant "from this disk": the row
          stayed, the run came straight back with a cloud icon, and its time
          stayed ranked. Now it means what it says where it can, and says
          exactly how far it reaches where it cannot. */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this run?"
          body={deleteReach()}
          confirmLabel="Delete for good"
          confirmTone="danger"
          cancelLabel="Keep it"
          onConfirm={() => { setDeleted(true); void handleDelete(); }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </aside>
  );

  /** How far the delete reaches, in one sentence, for the confirm. */
  function deleteReach(): string {
    if (run.remote) return "This removes it from the team's board. There is no copy on this machine.";
    if (mine) return "This removes it from this machine and from the team's board.";
    // Never launched from Helios: never shared, nothing else to reach.
    if (!run.driverId) return "This removes it from this machine.";
    if (!driverId) {
      return "This removes it from this machine. Its time stays on the team's board; sign in as its driver to take it down.";
    }
    return "This removes it from this machine. Its time stays on the team's board, where only its driver can take it down.";
  }

  async function handleDelete() {
    try {
      // The directory only exists for a local run; `sim_delete_run` refuses a
      // path that is not a run, which for a shared one is every path.
      if (!run.remote) await simDeleteRun(run.runId);
      onDeleted(run.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleted(false);
    }
  }
}

/** "Jordan — 39.100 · Sep 21 · Bicycle", marked when it is the viewer's PB. */
function ghostLabel(g: SimRun, isPb: boolean, viewerId: string | null): string {
  const d = g.startedAt ? new Date(g.startedAt) : null;
  const date = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "undated";
  const model = VEHICLE_MODELS.find((m) => m.id === vehicleModelOf(g))?.name ?? "";
  const pb = isPb ? (viewerId && g.driverId === viewerId ? " (your PB)" : " (their PB)") : "";
  return `${g.driver} — ${fmtTime(runBest(g))} · ${date} · ${model}${pb}`;
}

function Spinner() {
  return <IconLoader2 size={14} className="animate-spin" aria-hidden />;
}

function aidsText(run: SimRun): string {
  const on: string[] = [];
  if (run.assists.traction) on.push("TC");
  if (run.assists.abs) on.push("ABS");
  if (run.assists.autoShift) on.push("auto");
  return on.length ? on.join(", ") : "none";
}

function Headline({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded border border-helios-line bg-helios-panel px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-helios-muted">{label}</div>
      <div className={"font-mono text-lg font-semibold " + (accent ? "text-asu-gold" : "")}>{value}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-helios-muted">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  warn,
  title,
  testId,
}: {
  label: string;
  value: string;
  warn?: boolean;
  /** Hover text, for a value that needs a sentence to be fair to. */
  title?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs" title={title} data-testid={testId}>
      <span className="shrink-0 text-helios-dim">{label}</span>
      <span className={"min-w-0 text-right font-mono " + (warn ? "text-helios-warn" : "")}>{value}</span>
    </div>
  );
}

/**
 * The vehicle parameters the run was driven with.
 *
 * A lap time only means something next to the car that set it — the
 * differential, the brake bias and the roll distribution all move between
 * sessions — so the whole live parameter set is in the manifest and the whole
 * thing is shown, collapsed by default because it is 27 numbers. A teammate's
 * shared run has no manifest here, only the run-to-run setup its best lap was
 * set on (`stats.setup`), which is shown instead and says it is the short list.
 */
function SetupBlock({ setup, full }: { setup: Record<string, number>; full: boolean }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(setup).sort();
  return (
    <section className="mb-4">
      <button
        className="mb-1.5 flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-helios-muted transition hover:text-helios-dim"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{full ? "Car setup" : "Run-to-run setup"} ({keys.length})</span>
        <span>{open ? "hide" : "show"}</span>
      </button>
      {/* Two columns where there is room: this is 27 parameters, and one column
          of them is a long scroll for a panel you opened to check one number. */}
      {open && (
        <div className="grid gap-x-3 font-mono text-[11px] sm:grid-cols-2">
          {keys.map((k) => (
            <div key={k} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="truncate text-helios-dim">{k}</span>
              <span>{formatParam(setup[k]!)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatParam(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(3);
  return v.toPrecision(3);
}
