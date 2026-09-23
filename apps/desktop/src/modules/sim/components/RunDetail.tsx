import { useEffect, useMemo, useState } from "react";
import {
  IconChartLine, IconFolderOpen, IconMovie, IconStopwatch, IconTrash, IconX,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import {
  fmtBytes, fmtGap, fmtTime, fmtWhen, hasTelemetry, parseGeneratedId, runBest, runTheoretical,
  simDeleteRun, simReadRun, unrankedReason, type SimManifest, type SimRun,
} from "../api";
import { ghostCandidates } from "../lib/leaderboard";
import { GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT } from "../lib/share";

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
  onClose: () => void;
  onReplay: (run: SimRun, ghostId: string | null) => void;
  onOpenInLogs: (run: SimRun) => void;
  onChase: (run: SimRun) => void;
  onDeleted: (runId: string) => void;
}

export function RunDetail({
  run, allRuns, canReplay, driverId, lapShared = null, onClose, onReplay, onOpenInLogs, onChase, onDeleted,
}: Props) {
  const canDrive = !!driverId;
  const mine = !!driverId && run.driverId === driverId;
  const [manifest, setManifest] = useState<SimManifest | null>(null);
  const [ghostId, setGhostId] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The full manifest carries the setup and the event list, which the listing
  // deliberately does not; it is read only when a run is actually opened.
  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setGhostId("");
    setConfirmDelete(false);
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

  const ghosts = useMemo(() => ghostCandidates(allRuns, run), [allRuns, run]);
  const best = runBest(run);
  // How many laps this run's course keeps. See `limitsFor`.
  const lim = limitsFor(run.track);
  const reason = unrankedReason(run);
  const st = run.stats;

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-helios-line bg-helios-strip">
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

        <Group title="The run">
          <Row label="Laps" value={String(st.laps)} />
          <Row label="Wheel time" value={`${st.durationS.toFixed(1)} s`} />
          <Row label="Distance" value={`${(st.distanceM / 1000).toFixed(2)} km`} />
          <Row label="Cones" value={String(st.totalCones)} warn={st.totalCones > 0} />
          <Row label="Off course" value={String(st.totalOffCourse)} warn={st.totalOffCourse > 0} />
          <Row label="Ended" value={run.finishedReason ?? "—"} />
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
                  // By lap number, not by comparing floats: `best` comes from
                  // the manifest's own `bestLapS`, and two laps that tie would
                  // otherwise both light up.
                  const isBest = run.stats.bestLapNumber != null
                    ? l.lap === run.stats.bestLapNumber
                    : best != null && l.total === best;
                  return (
                    <tr key={l.lap} className="border-t border-helios-line/50">
                      <td className="py-1">L{l.lap}</td>
                      <td className={"py-1 text-right " + (isBest ? "text-asu-gold" : "")}>
                        {fmtTime(l.total)}
                      </td>
                      <td className="py-1 text-right text-helios-dim">
                        {isBest || best == null ? "—" : fmtGap(l.total - best)}
                      </td>
                      <td className="py-1 pl-2 text-helios-dim">
                        {l.sectors.length ? l.sectors.map((s) => (s == null ? "—" : s.toFixed(2))).join(" / ") : "—"}
                        {(l.cones > 0 || l.off > 0) && (
                          <span className="ml-1 font-sans text-helios-warn">
                            {l.cones > 0 && `${l.cones}c`}{l.off > 0 && ` ${l.off}off`}
                          </span>
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

        {manifest?.setup && Object.keys(manifest.setup).length > 0 && (
          <SetupBlock setup={manifest.setup} />
        )}

        {error && <p className="text-xs text-helios-danger">{error}</p>}
      </div>

      <footer className="border-t border-helios-line px-4 py-3">
        {ghosts.length > 0 && canReplay && (
          <label className="mb-2 block">
            <span className="mb-1 block text-[11px] text-helios-dim">Ghost to drive against</span>
            <select
              className="w-full rounded border border-helios-line bg-helios-deep px-2 py-1.5 text-xs outline-none focus:border-asu-gold"
              value={ghostId}
              onChange={(e) => setGhostId(e.target.value)}
            >
              <option value="">No ghost</option>
              {ghosts.slice(0, 20).map((g) => (
                <option key={g.runId} value={g.runId}>
                  {g.driver} — {fmtTime(runBest(g))}
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
            disabled={!canReplay || !hasTelemetry(run)}
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
            <IconMovie size={14} /> Watch replay
          </button>
          <button
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-helios-line px-3 py-2 text-xs transition hover:border-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasTelemetry(run)}
            title={
              !hasTelemetry(run)
                ? run.remote
                  ? `${run.driver} shared this run's time, not the lap itself`
                  : "This run has no telemetry file"
                : run.remote
                  ? `Fetch ${run.driver}'s lap and open it in Logs`
                  : undefined
            }
            onClick={() => onOpenInLogs(run)}
          >
            <IconChartLine size={14} /> Open in Logs
          </button>
        </div>
        <button
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded border border-asu-gold/50 bg-asu-gold/10 px-3 py-2 text-xs font-medium text-asu-gold transition hover:bg-asu-gold/20 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canReplay || !canDrive || best == null || !hasTelemetry(run)}
          title={
            best == null
              ? "this run has no time to chase"
              : !hasTelemetry(run)
                ? run.remote
                  ? `${run.driver} shared this run's time, not the lap itself`
                  : "This run has no telemetry file to chase"
                : !canDrive
                  ? "Sign in to Helios to start a run"
                  : canReplay
                    ? run.remote
                      ? `Fetch ${run.driver}'s lap and drive against it`
                      : "Start a drive with this lap as the live delta's reference"
                    : "The simulator is not installed here"
          }
          onClick={() => onChase(run)}
        >
          <IconStopwatch size={14} /> Drive against this lap
        </button>
        {/* What "delete" will actually do, said before it is done. The button
            reads "for good" and for a while meant "from this disk": the row
            stayed, the run came straight back with a cloud icon, and its time
            stayed ranked. Now it means what it says where it can, and says
            exactly how far it reaches where it cannot. */}
        {confirmDelete && (
          <p className="mt-2 text-[11px] text-helios-dim">{deleteReach()}</p>
        )}
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
          {(!run.remote || mine) && (confirmDelete ? (
            <span className="inline-flex flex-1 items-center gap-1">
              <button
                className="flex-1 rounded bg-helios-danger px-2 py-1.5 text-[11px] font-semibold text-white"
                onClick={() => void handleDelete()}
              >
                Delete for good
              </button>
              <button
                className="rounded border border-helios-line px-2 py-1.5 text-[11px]"
                onClick={() => setConfirmDelete(false)}
              >
                No
              </button>
            </span>
          ) : (
            <button
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-helios-line px-3 py-1.5 text-[11px] text-helios-dim transition hover:border-helios-danger hover:text-helios-danger"
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrash size={13} /> Delete run
            </button>
          ))}
        </div>
      </footer>
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
      setConfirmDelete(false);
    }
  }
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
}: {
  label: string;
  value: string;
  warn?: boolean;
  /** Hover text, for a value that needs a sentence to be fair to. */
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs" title={title}>
      <span className="text-helios-dim">{label}</span>
      <span className={"font-mono " + (warn ? "text-helios-warn" : "")}>{value}</span>
    </div>
  );
}

/**
 * The vehicle parameters the run was driven with.
 *
 * A lap time only means something next to the car that set it — the
 * differential, the brake bias and the roll distribution all move between
 * sessions — so the whole live parameter set is in the manifest and the whole
 * thing is shown, collapsed by default because it is 27 numbers.
 */
function SetupBlock({ setup }: { setup: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(setup).sort();
  return (
    <section className="mb-4">
      <button
        className="mb-1.5 flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-helios-muted transition hover:text-helios-dim"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Car setup ({keys.length})</span>
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
