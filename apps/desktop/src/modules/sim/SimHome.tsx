import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconList, IconPlayerPlayFilled, IconRefresh, IconTrophy,
} from "@tabler/icons-react";
import { useHeliosAuth, userDisplayName } from "../../auth/AuthShell";
import { ToastHost } from "../../components/ToastHost";
import { requestSignIn } from "../../lib/open-auth";
import { requestOpenInLogs } from "../../lib/open-in-logs";
import { LaunchPanel, readLaunchPrefs } from "./components/LaunchPanel";
import { useSimAutoUpdate } from "./components/useSimAutoUpdate";
import { Leaderboard } from "./components/Leaderboard";
import { RunDetail } from "./components/RunDetail";
import { RunsTable } from "./components/RunsTable";
import { SessionSummary, runsInSession, type SessionWindow } from "./components/SessionSummary";
import { SyncPill, type SyncState } from "./components/SyncPill";
import type { Pending, PendingAction } from "./components/pending";
import { listen } from "@tauri-apps/api/event";
import { deleteSharedRun, fetchSharedRuns, fetchSharedTelemetry, pushRuns, telemetryToKeep } from "./lib/share";
import { simError, simInfo, simToasts } from "./lib/toast";
import { readRunTelemetry, simImportRun, simLaunch, simListRuns, simStatus, simTelemetryPath,
  fmtTime, runBest,
  type SimManifest, type SimRun, type SimStatus, type VehicleModel,
  TRACKS, VEHICLE_MODELS, isTrackId, trackName, vehicleModelOf,
} from "./api";
import { courseName, sectorWindowS, type SectorComparison } from "./lib/leaderboard";

type Tab = "launch" | "runs" | "board";

const TAB_KEY = "helios:sim:tab";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "launch", label: "Launch", icon: <IconPlayerPlayFilled size={14} /> },
  { id: "runs", label: "Runs", icon: <IconList size={14} /> },
  { id: "board", label: "Leaderboard", icon: <IconTrophy size={14} /> },
];

/**
 * The simulator's home in Helios.
 *
 * Three things, because a race team does three things with a simulator: get
 * somebody into it, look at what came out, and argue about who is quickest.
 *
 * The run archive is a directory on disk that the simulator writes to while
 * Helios is running, so the listing is re-read on a timer as well as on
 * demand — a driver finishing a lap next door should see it appear here
 * without anyone pressing anything.
 */
export function SimHome({ active }: { active: boolean }) {
  const { user, client } = useHeliosAuth();
  // The one identity the whole module trusts. Null means signed out, and
  // signed out means no run can be started at all: a lap time has to be
  // attributable to a person before it can go on a board.
  const driver = useMemo(
    () => (user ? { id: user.id, name: userDisplayName(user) } : null),
    [user],
  );
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "runs" || saved === "board" || saved === "launch" ? saved : "runs";
    } catch {
      return "runs";
    }
  });
  const [status, setStatus] = useState<SimStatus | null>(null);
  /**
   * The simulator is kept on the feed's build without anybody asking. Owned
   * here rather than by the Launch tab, because the default tab is Runs and
   * an update that only happened on a tab nobody opened is an update that
   * never happened.
   */
  const update = useSimAutoUpdate(status, setStatus);
  /** What is on this machine's disk. */
  const [runs, setRuns] = useState<SimRun[]>([]);
  /** What the rest of the team has shared. Empty when signed out. */
  const [shared, setShared] = useState<SimRun[]>([]);
  /** Where the team's half stands, for the header pill. See `SyncPill`. */
  const [sync, setSync] = useState<SyncState>(() => (client && driver ? { kind: "syncing", at: null } : { kind: "signed-out" }));
  /** "Fetching Jordan's lap…" while a shared run is being brought here. */
  const [fetching, setFetching] = useState<string | null>(null);
  /** The button waiting on that, so it can say so. */
  const [pending, setPending] = useState<Pending | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Set when a simulator Helios launched has just exited; drives the summary. */
  const [session, setSession] = useState<SessionWindow | null>(null);
  /** What the simulator Helios started is doing, until it exits. */
  const [running, setRunning] = useState<string | null>(null);

  const selectTab = useCallback((t: Tab) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ }
  }, []);

  // Every refresh takes a ticket; only the newest one may write. Without it
  // the 6-second poll resurrects a run the user has just deleted -- the request
  // went out before the delete, lands after it, and puts the row back with a
  // run id that no longer exists on disk.
  const seq = useRef(0);
  // The archive read fails the same way every six seconds when it fails at
  // all. Said once per distinct failure, not once per poll -- and the toast
  // stays up after a later poll succeeds, which is the point: it used to be a
  // header line the next good poll erased before anyone had read it.
  const lastRefreshError = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [s, list] = await Promise.all([simStatus(), simListRuns()]);
      if (mine !== seq.current) return;
      setStatus(s);
      setRuns(list);
      lastRefreshError.current = null;
    } catch (e) {
      if (mine !== seq.current) return;
      const msg = `Could not read the run archive: ${e instanceof Error ? e.message : String(e)}`;
      if (lastRefreshError.current !== msg) {
        lastRefreshError.current = msg;
        simError(msg);
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  /**
   * Read the team's runs, and push the ones this machine has that it has not.
   *
   * Deliberately separate from `refresh`, which reads a directory and must
   * stay instant and never fail because a rig is offline. This half is the
   * network, and everything it does is optional: signed out, or with no
   * connection, the module carries on showing what is on this disk -- and the
   * header pill says that is what it is doing.
   */
  const syncShared = useCallback(async (local: SimRun[]) => {
    if (!client || !driver) { setShared([]); setSync({ kind: "signed-out" }); return; }
    setSync((s) => ({ kind: "syncing", at: s.kind === "ok" || s.kind === "syncing" || s.kind === "offline" ? s.at : null }));
    try {
      const theirs = await fetchSharedRuns(client);
      setShared(theirs);
      setSync({ kind: "ok", at: Date.now() });
      const res = await pushRuns(client, driver.id, local, async (run) => {
        // Read straight off disk. The telemetry never passes through the
        // simulator or a temp copy; it is the file that was recorded.
        const text = await readRunTelemetry(run.runId);
        return text == null ? null : new TextEncoder().encode(text);
      }, theirs);
      if (res.pushed || res.telemetryPushed) {
        const again = await fetchSharedRuns(client);
        setShared(again);
      }
      // Reading worked, so the board is live; sharing this machine's runs did
      // not. Said once, and left up: a run that never reached the team is
      // exactly the thing a driver would not otherwise find out about.
      if (res.error) simError(`Could not share this machine's runs with the team: ${res.error}`);
    } catch (e) {
      // Offline at a test day is the normal state of a rig, not an error: the
      // pill says so, and the reason is on its tooltip.
      setSync((s) => ({
        kind: "offline",
        at: s.kind === "ok" || s.kind === "syncing" || s.kind === "offline" ? s.at : null,
        message: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [client, driver]);

  /**
   * WHEN to sync.
   *
   * Not on every listing. `refresh` hands back a fresh array every six
   * seconds whether or not anything changed, and syncing on the array's
   * identity meant a whole-table read, a per-user read and possibly a
   * fifty-row upsert every six seconds per open client -- two hundred
   * whole-table selects a minute across twenty of them. Worse, one row the
   * server will not take (a manifest whose `startedAt` does not parse as a
   * timestamp, say) failed the whole batch every six seconds, and nothing
   * ever pushed for anyone.
   *
   * So: on sign-in, and when the SET of local run ids changes. A run being
   * written or deleted is what changes the listing, and the ids are what say
   * so; the simulator exiting lands here through the run it wrote, and an
   * exit that wrote nothing has nothing to push.
   */
  const localIds = useMemo(() => runs.map((r) => r.runId).sort().join("\n"), [runs]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  // One at a time. Two syncs overlapping would both read the same rows and
  // both decide to push them; a request that lands mid-sync runs once more
  // afterwards rather than alongside.
  const syncing = useRef(false);
  const syncAgain = useRef(false);
  const requestSync = useCallback(() => {
    if (syncing.current) { syncAgain.current = true; return; }
    syncing.current = true;
    void (async () => {
      do {
        syncAgain.current = false;
        await syncShared(runsRef.current);
      } while (syncAgain.current);
      syncing.current = false;
    })();
  }, [syncShared]);

  // `requestSync` changes identity with `syncShared`, which changes with the
  // signed-in account: that is the sign-in trigger. Waits for the first
  // listing, because pushing runs that have not been listed yet would be
  // pushing nothing.
  useEffect(() => {
    if (loading) return;
    requestSync();
  }, [loading, localIds, requestSync]);

  // The board stays live for somebody only watching it, without the write
  // half: a teammate's new time is a row they pushed, and reading the table
  // once a minute is cheap where syncing it every six seconds was not.
  useEffect(() => {
    if (!active || !client || !driver) return;
    const id = window.setInterval(() => {
      fetchSharedRuns(client)
        .then((theirs) => { setShared(theirs); setSync({ kind: "ok", at: Date.now() }); })
        .catch((e) => {
          setSync((s) => ({
            kind: "offline",
            at: s.kind === "ok" || s.kind === "syncing" || s.kind === "offline" ? s.at : null,
            message: e instanceof Error ? e.message : String(e),
          }));
        });
    }, 60_000);
    return () => window.clearInterval(id);
  }, [active, client, driver]);

  /**
   * Everything, local and shared, with the local copy winning.
   *
   * By run id, and local first on purpose: the same run is on this disk AND
   * in the team archive once it has been pushed, and the local one is the one
   * with files behind it -- it can be replayed and opened in Logs, and its
   * shared twin cannot.
   */
  /** The merged list, for callbacks that must not close over a stale copy. */
  const allRunsRef = useRef<SimRun[]>([]);
  const allRuns = useMemo(() => {
    const byId = new Map<string, SimRun>();
    for (const r of shared) byId.set(r.runId, r);
    for (const r of runs) byId.set(r.runId, r);
    const merged = [...byId.values()];
    allRunsRef.current = merged;
    return merged;
  }, [runs, shared]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while this module is on screen. A run finishing in the
  // simulator should show up here on its own, but a hidden module has no
  // business reading a directory every few seconds.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => { void refresh(); }, 6000);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  const selected = useMemo(
    () => allRuns.find((r) => r.runId === selectedId) ?? null,
    [allRuns, selectedId],
  );
  // Nothing launches while the executable is being replaced.
  const canReplay = !!status?.exePath && !update.installing;

  /**
   * Which of the signed-in driver's runs currently have their lap (the
   * telemetry) in the team's copy, so a run can say whether it is one of
   * them. The same rule `pushRuns` prunes by, evaluated on the same list.
   */
  const sharedLapIds = useMemo(
    () => (driver ? telemetryToKeep(allRuns, driver.id) : new Set<string>()),
    [allRuns, driver],
  );

  /**
   * Run `fn` with the clicked button marked as working. One at a time: a
   * second click on anything while a fetch is in flight waits for nothing,
   * it simply does not start a second download.
   */
  const pendingRef = useRef<Pending | null>(null);
  const withPending = useCallback(async (runId: string, action: PendingAction, fn: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = { runId, action };
    setPending(pendingRef.current);
    try {
      await fn();
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }, []);

  /**
   * Bring a shared run onto this machine so it can be opened.
   *
   * The simulator replays a DIRECTORY and Logs reads a FILE; a teammate's run
   * is a row and a storage object. Rather than teach either of them about the
   * network, the run is written into the local archive once and is then an
   * ordinary run -- replayable, openable, deletable, indistinguishable from
   * one driven here. Returns false when there is nothing to fetch, which is
   * most runs: only a personal best carries its telemetry.
   */
  const materialise = useCallback(async (run: SimRun): Promise<boolean> => {
    if (!run.remote) return true;
    if (!client) { simError("Sign in to Helios to open a shared run."); return false; }
    if (!run.telemetryObject) {
      simError(`${run.driver} shared that run's time but not the lap itself.`);
      return false;
    }
    try {
      setFetching(`Fetching ${run.driver}'s lap…`);
      const csv = await fetchSharedTelemetry(client, run);
      // The manifest the simulator will read back. Rebuilt from the row
      // rather than shared as a blob: the row IS the manifest's fields, and
      // storing it twice is how the two come to disagree.
      await simImportRun(run.runId, {
        ...run,
        dir: undefined,
        telemetryPath: undefined,
        telemetryBytes: undefined,
        remote: undefined,
      } as unknown as SimManifest, csv);
      await refresh();
      return true;
    } catch (e) {
      simError(`Could not fetch ${run.driver}'s lap: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setFetching(null);
    }
  }, [client, refresh]);

  /** A run's local telemetry path, asking the backend when it has only just
   *  been fetched and this render's listing has not caught up. */
  const localPath = useCallback(
    (run: SimRun): Promise<string> =>
      run.remote ? simTelemetryPath(run.runId) : Promise.resolve(run.telemetryPath),
    [],
  );

  /**
   * Open a replay, and its ghost, bringing BOTH onto this machine first.
   *
   * The simulator reads the ghost out of the runs directory exactly as it
   * reads the replay. Only the replay used to be fetched, so a teammate's lap
   * offered as a ghost launched into "GHOST NOT LOADED": the id was on the
   * command line and nothing was on disk behind it. A ghost that cannot be
   * fetched now drops out and the replay opens without it -- the reason is
   * already on screen from `materialise`.
   */
  const launchReplay = useCallback(async (req: {
    replay: string; ghost?: string | null; replayLap?: number | null; ghostLap?: number | null; sector?: number | null;
  }) => {
    const find = (id: string) => allRunsRef.current.find((r) => r.runId === id);
    await withPending(req.replay, "replay", async () => {
      const run = find(req.replay);
      if (run && !(await materialise(run))) return;
      let ghost = req.ghost ?? null;
      const g = ghost ? find(ghost) : undefined;
      if (ghost && g && !(await materialise(g))) ghost = null;
      try {
        await simLaunch({
          replay: req.replay,
          ghost: ghost ?? undefined,
          replayLap: req.replayLap ?? undefined,
          ghostLap: ghost ? req.ghostLap ?? undefined : undefined,
          sector: req.replayLap != null ? req.sector ?? undefined : undefined,
        });
        if (run) simInfo(`Opening the replay of ${run.driver}'s ${trackName(run.track)} run${g && ghost ? `, ${g.driver} as the ghost` : ""}`, "info");
      } catch (e) {
        simError(e);
      }
    });
  }, [materialise, withPending]);

  const replay = useCallback((runId: string, ghostId: string | null) => {
    void launchReplay({ replay: runId, ghost: ghostId });
  }, [launchReplay]);

  /** Watch a sector: its lap, starting at the sector, the driver's own lap as the ghost. */
  const watchSector = useCallback((c: SectorComparison) => {
    void launchReplay({
      replay: c.target.runId,
      replayLap: c.target.lap,
      ghost: c.against?.runId ?? null,
      ghostLap: c.against?.lap ?? null,
      sector: c.sector + 1,
    });
  }, [launchReplay]);

  /**
   * Open one lap, or two side by side, in Logs: `target` as Main and
   * `against` as Ref, in the lap-analysis workspace, optionally zoomed.
   *
   * Every "open in Logs" goes through here now. The runs table and the detail
   * panel used to send the path alone, so Logs opened the file and left the
   * user to find the lap; the sector compare already sent Main/Ref and the
   * workspace, and there is no reason one door into Logs should be better
   * furnished than another.
   */
  const openLaps = useCallback(async (
    target: { run: SimRun; lap: number | null; tag?: string },
    against: { run: SimRun; lap: number | null; tag?: string } | null,
    zoom?: (targetPath: string) => { path: string; startS: number; endS: number } | undefined,
  ) => {
    if (!(await materialise(target.run))) return;
    if (against && !(await materialise(against.run))) return;
    let targetPath: string, againstPath: string | null;
    try {
      [targetPath, againstPath] = await Promise.all([
        localPath(target.run),
        against ? localPath(against.run) : Promise.resolve(null),
      ]);
    } catch (e) {
      simError(e);
      return;
    }
    const lapTag = (lap: number | null) => (lap != null ? ` L${lap}` : "");
    const sameRun = againstPath == null || targetPath === againstPath;
    const paths = sameRun ? [targetPath] : [targetPath, againstPath!];
    const labels = sameRun
      ? [`${target.run.driver} — ${target.run.trackName}`]
      : [
          `${target.run.driver}${lapTag(target.lap)} — ${target.run.trackName}${target.tag ? ` (${target.tag})` : ""}`,
          `${against!.run.driver}${lapTag(against!.lap)} — ${against!.run.trackName}${against!.tag ? ` (${against!.tag})` : ""}`,
        ];
    requestOpenInLogs(paths, undefined, {
      labels,
      selection: {
        main: target.lap != null ? { path: targetPath, lap: target.lap } : undefined,
        ref: against && againstPath && against.lap != null ? { path: againstPath, lap: against.lap } : undefined,
        zoom: zoom?.(targetPath),
        workspace: "lap-analysis",
      },
    });
  }, [materialise, localPath]);

  /**
   * Put a sector's lap and the driver's own side by side in Logs: the sector's
   * as Main, theirs as Ref, zoomed to the sector.
   */
  const compareSector = useCallback((c: SectorComparison) => {
    if (!c.against) return;
    const against = c.against;
    const find = (id: string) => allRunsRef.current.find((r) => r.runId === id);
    const target = find(c.target.runId);
    const mine = find(against.runId);
    if (!target || !mine) return;
    void withPending(target.runId, "compare", () => openLaps(
      { run: target, lap: c.target.lap, tag: `S${c.sector + 1}` },
      { run: mine, lap: against.lap, tag: "mine" },
      (targetPath) => {
        const win = sectorWindowS(target, c.target.lap, c.sector);
        return win ? { path: targetPath, startS: win.startS, endS: win.endS } : undefined;
      },
    ));
  }, [openLaps, withPending]);

  /** One run's best lap in Logs, as Main, in the lap-analysis workspace. */
  const openInLogs = useCallback((run: SimRun) => {
    void withPending(run.runId, "logs", () => openLaps({ run, lap: run.stats.bestLapNumber ?? null }, null));
  }, [openLaps, withPending]);

  /** Two runs' best laps in Logs: `run` as Main, `against` as Ref. */
  const compareRuns = useCallback((run: SimRun, against: SimRun, againstTag: string) => {
    void withPending(run.runId, "compare", () => openLaps(
      { run, lap: run.stats.bestLapNumber ?? null },
      { run: against, lap: against.stats.bestLapNumber ?? null, tag: againstTag },
    ));
  }, [openLaps, withPending]);

  /** Drive a course on a given car model, with the launcher's other
   *  settings -- the leaderboard's "Launch 4-wheel". */
  const launchCourse = useCallback((track: string, model: VehicleModel) => {
    if (!driver) { simError("Sign in to Helios to start a run."); return; }
    if (update.installing) { simError("The simulator is being updated; try again in a moment."); return; }
    const prefs = readLaunchPrefs();
    const course = isTrackId(track) ? track : TRACKS[0]!.id;
    const what = `${courseName(course)} · ${VEHICLE_MODELS.find((m) => m.id === model)?.name ?? "car"}`;
    void simLaunch({
      track: course,
      vehicleModel: model,
      profile: prefs.profile || undefined,
      driver: driver.name,
      driverId: driver.id,
      session: prefs.session || undefined,
      traction: prefs.traction,
      abs: prefs.abs,
      autoShift: prefs.autoShift,
      autostart: prefs.autostart,
      windowed: prefs.windowed,
      noRecord: !prefs.record,
    }).then(() => {
      simInfo(`Sent to simulator: ${what}`);
      setRunning(what);
    }).catch(simError);
  }, [driver, update.installing]);

  /**
   * Start a drive with this run's best lap as the live delta's reference.
   *
   * Everything else about the launch comes from whatever the Launch tab is
   * set to, so "drive against this lap" changes one thing and leaves the
   * driver's own course, controls and aids alone -- except the course and
   * the car, which have to be the ones the reference was set on or the
   * reference is nonsense.
   */
  const chase = useCallback((run: SimRun) => {
    if (!driver) { simError("Sign in to Helios to start a run."); return; }
    if (update.installing) { simError("The simulator is being updated; try again in a moment."); return; }
    // The launcher's own reader, not a second copy of it here.
    const prefs = readLaunchPrefs();
    // `run.track` comes off a manifest and can be anything -- a run whose
    // manifest had no track at all is listed as "unknown", and `as never`
    // walked that straight into `sim_launch`, which rejects it with an error
    // about a course nobody asked for. Fall back to the course the launcher
    // defaults to and let the driver pick.
    const track = isTrackId(run.track) ? run.track : TRACKS[0]!.id;
    const whose = run.driverId === driver.id ? "your" : `${run.driver}'s`;
    const what = `${courseName(track)} against ${whose} ${fmtTime(runBest(run))}`;
    void withPending(run.runId, "chase", async () => {
      // The simulator reads the reference out of the runs directory -- it
      // builds its time-at-distance table from the lap's telemetry -- so a
      // shared run has to be brought here first, exactly as a replay does.
      if (!(await materialise(run))) return;
      try {
        await simLaunch({
          track,
          profile: prefs.profile || undefined,
          driver: driver.name,
          driverId: driver.id,
          session: prefs.session || undefined,
          traction: prefs.traction,
          abs: prefs.abs,
          autoShift: prefs.autoShift,
          autostart: prefs.autostart,
          windowed: prefs.windowed,
          noRecord: !prefs.record,
          reference: run.runId,
          // Chasing a lap means driving the car it was set on.
          vehicleModel: vehicleModelOf(run),
        });
        simInfo(`Sent to simulator: ${what}`);
        setRunning(what);
      } catch (e) {
        simError(e);
      }
    });
  }, [driver, materialise, update.installing, withPending]);

  /**
   * The simulator Helios started has closed.
   *
   * Come back to Runs and say what happened. The driver's attention is already
   * on this window -- they just alt-tabbed into it -- and the one thing they
   * want to know is how the session went, not which tab they happened to leave
   * open twenty minutes ago.
   *
   * Mounted once and left listening: the module stays mounted when it is not
   * the visible one (that is how the Shell works), so a session that ends
   * while the user is in Logs still lands, and they find the summary waiting.
   */
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    listen<{ startedAtMs: number; endedAtMs: number }>("sim://exited", (ev) => {
      const win = ev.payload;
      if (!win || typeof win.startedAtMs !== "number") return;
      // Whatever it was running, it is not any more.
      setRunning(null);
      // Re-read first: the last run is written as the window closes, so the
      // list in hand is one run out of date at exactly this moment.
      void refresh().then(() => {
        setSession({ startedAtMs: win.startedAtMs, endedAtMs: win.endedAtMs });
        selectTab("runs");
      });
    })
      .then((un) => {
        if (cancelled) un();
        else stop = un;
      })
      .catch(() => { /* not in the desktop shell; there is nothing to listen to */ });
    return () => { cancelled = true; stop?.(); };
  }, [refresh, selectTab]);

  const sessionRuns = useMemo(
    () => (session ? runsInSession(runs, session) : []),
    [runs, session],
  );

  const findRun = (id: string) => allRunsRef.current.find((r) => r.runId === id);
  // The detail panel sits beside the Runs table AND the Leaderboard: a row on
  // the board opens the run where you are, instead of throwing you to another
  // tab to look at it.
  const showDetail = !!selected && (tab === "runs" || tab === "board");
  const teamState: "ok" | "offline" | "signed-out" =
    sync.kind === "signed-out" ? "signed-out" : sync.kind === "offline" ? "offline" : "ok";

  return (
    <div data-module="sim" className="relative flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex items-center gap-1 border-b border-helios-line px-3 py-2">
        <div role="tablist" aria-label="Sim" className="flex items-center gap-1">
          {TABS.map((t) => (
            <TabBtn key={t.id} active={tab === t.id} onClick={() => selectTab(t.id)} icon={t.icon} id={t.id}>
              {t.label}
              {t.id === "runs" && runs.length > 0 && <Count>{runs.length}</Count>}
            </TabBtn>
          ))}
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {/* Visible from every tab: a driver on Runs should know the
              executable is changing under them before they press Replay. */}
          {update.installing && update.build && (
            <span className="rounded-full bg-asu-gold/15 px-2 py-0.5 text-[11px] text-asu-gold">
              Updating simulator to {update.build.version}
              {update.build.bytes ? ` · ${Math.min(100, (update.got / update.build.bytes) * 100).toFixed(0)}%` : ""}
            </span>
          )}
          <SyncPill state={sync} fetching={fetching} onSignIn={requestSignIn} onRetry={requestSync} />
          <button
            className="rounded p-1 text-helios-dim transition hover:text-helios-text"
            title="Re-read the run archive and sync with the team"
            aria-label="Re-read the run archive and sync with the team"
            onClick={() => { void refresh(); requestSync(); }}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto" role="tabpanel" aria-labelledby={`sim-tab-${tab}`}>
          {/* Launching needs the simulator's status and nothing else, so the
              Launch tab does not wait for the archive to be read. */}
          {tab === "launch" ? (
            <LaunchPanel
              status={status}
              driver={driver}
              onStatusChange={setStatus}
              onLaunched={(what) => { setRunning(what); void refresh(); }}
              running={running}
              onSignIn={requestSignIn}
              update={update}
            />
          ) : loading ? (
            <p className="p-8 text-center text-sm text-helios-dim">Reading the run archive…</p>
          ) : tab === "board" ? (
            <Leaderboard
              runs={allRuns}
              onLaunchCourse={launchCourse}
              canReplay={canReplay}
              selectedId={selectedId}
              compact={showDetail}
              onOpenRun={(id) => setSelectedId((cur) => (cur === id ? null : id))}
              onReplayRun={(id) => replay(id, null)}
              onChaseRun={(id) => { const r = findRun(id); if (r) chase(r); }}
              onCompareRuns={(id, againstId, tag) => {
                const r = findRun(id), a = findRun(againstId);
                if (r && a) compareRuns(r, a, tag);
              }}
              pending={pending}
              driverId={driver?.id ?? null}
              teamState={teamState}
              onSignIn={requestSignIn}
              onWatchSector={watchSector}
              onCompareSector={compareSector}
            />
          ) : (
            <RunsTable
              runs={allRuns}
              selectedId={selectedId}
              canReplay={canReplay}
              driverId={driver?.id ?? null}
              pending={pending}
              onSelect={(r) => setSelectedId(r.runId === selectedId ? null : r.runId)}
              onReplay={(r) => replay(r.runId, null)}
              onOpenInLogs={openInLogs}
            />
          )}
        </div>

        {session && (
          <SessionSummary
            runs={sessionRuns}
            session={session}
            allRuns={allRuns}
            viewerId={driver?.id ?? null}
            canReplay={canReplay}
            onClose={() => setSession(null)}
            onOpenRun={(id) => { setSelectedId(id); setSession(null); }}
            onReplay={(id) => { setSession(null); replay(id, null); }}
          />
        )}

        {showDetail && selected && (
          <RunDetail
            run={selected}
            allRuns={allRuns}
            canReplay={canReplay}
            driverId={driver?.id ?? null}
            pending={pending}
            lapShared={driver && selected.driverId === driver.id ? sharedLapIds.has(selected.runId) : null}
            onClose={() => setSelectedId(null)}
            onReplay={(r, ghostId) => replay(r.runId, ghostId)}
            onOpenInLogs={openInLogs}
            onCompareInLogs={compareRuns}
            onChase={chase}
            onDeleted={(id) => {
              setSelectedId(null);
              // Invalidate any refresh already in flight, so its older listing
              // cannot put this row back.
              seq.current += 1;
              const run = allRunsRef.current.find((r) => r.runId === id);
              setRuns((prev) => prev.filter((r) => r.runId !== id));
              // And from the team's copy. Filtering only the local list left
              // the shared row in the merge, so the run came straight back
              // with a cloud icon, still ranked -- "Delete for good" had
              // meant "from this disk". A run of your own goes off the board
              // as well; anybody else's was never yours to take down.
              setShared((prev) => prev.filter((r) => r.runId !== id));
              if (client && driver && run?.driverId === driver.id) {
                deleteSharedRun(client, id).catch((e) => {
                  simError(`Deleted here, but could not remove it from the team's board: ${e instanceof Error ? e.message : String(e)}`);
                });
              }
            }}
          />
        )}
      </div>
      <ToastHost store={simToasts} />
    </div>
  );
}

function TabBtn({
  active, onClick, icon, children, id,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode; id: string }) {
  return (
    <button
      role="tab"
      id={`sim-tab-${id}`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={(e) => {
        // Arrow keys move along the tab bar, as a tablist is expected to.
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const tabs = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
        const i = tabs.indexOf(e.currentTarget);
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next?.focus();
        next?.click();
      }}
      className={
        "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
        (active
          ? "bg-asu-gold/15 text-asu-gold"
          : "text-helios-dim hover:bg-helios-line/40 hover:text-helios-text")
      }
    >
      {icon}
      {children}
    </button>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1 rounded-full bg-helios-line px-1.5 text-[10px] font-normal text-helios-dim">
      {children}
    </span>
  );
}
