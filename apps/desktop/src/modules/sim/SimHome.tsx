import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconList, IconPlayerPlayFilled, IconRefresh, IconTrophy,
} from "@tabler/icons-react";
import { useHeliosAuth, userDisplayName } from "../../auth/AuthShell";
import { requestOpenInLogs } from "../../lib/open-in-logs";
import { LaunchPanel, readLaunchPrefs } from "./components/LaunchPanel";
import { useSimAutoUpdate } from "./components/useSimAutoUpdate";
import { Leaderboard } from "./components/Leaderboard";
import { RunDetail } from "./components/RunDetail";
import { RunsTable } from "./components/RunsTable";
import { SessionSummary, runsInSession, type SessionWindow } from "./components/SessionSummary";
import { listen } from "@tauri-apps/api/event";
import { deleteSharedRun, fetchSharedRuns, fetchSharedTelemetry, pushRuns, telemetryToKeep } from "./lib/share";
import { readRunTelemetry, simImportRun, simLaunch, simListRuns, simStatus,
  type SimManifest, type SimRun, type SimStatus,
  TRACKS, isTrackId,
} from "./api";

type Tab = "launch" | "runs" | "board";

const TAB_KEY = "helios:sim:tab";

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
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Set when a simulator Helios launched has just exited; drives the summary. */
  const [session, setSession] = useState<SessionWindow | null>(null);

  const selectTab = useCallback((t: Tab) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ }
  }, []);

  // Every refresh takes a ticket; only the newest one may write. Without it
  // the 6-second poll resurrects a run the user has just deleted -- the request
  // went out before the delete, lands after it, and puts the row back with a
  // run id that no longer exists on disk.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [s, list] = await Promise.all([simStatus(), simListRuns()]);
      if (mine !== seq.current) return;
      setStatus(s);
      setRuns(list);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
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
   * connection, the module carries on showing what is on this disk.
   */
  const syncShared = useCallback(async (local: SimRun[]) => {
    if (!client || !driver) { setShared([]); return; }
    try {
      const theirs = await fetchSharedRuns(client);
      setShared(theirs);
      setShareNote(null);
      const res = await pushRuns(client, driver.id, local, async (run) => {
        // Read straight off disk. The telemetry never passes through the
        // simulator or a temp copy; it is the file that was recorded.
        const text = await readRunTelemetry(run.runId);
        return text == null ? null : new TextEncoder().encode(text);
      });
      if (res.pushed || res.telemetryPushed) {
        const again = await fetchSharedRuns(client);
        setShared(again);
      }
      if (res.error) setShareNote(res.error);
    } catch (e) {
      // Offline at a test day is the normal state of a rig, not an error.
      setShareNote(e instanceof Error ? e.message : String(e));
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
      fetchSharedRuns(client).then(setShared).catch(() => { /* offline is normal */ });
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
    if (!client) { setError("Sign in to Helios to open a shared run."); return false; }
    if (!run.telemetryObject) {
      setError(`${run.driver} shared that run's time but not the lap itself.`);
      return false;
    }
    try {
      setShareNote(`Fetching ${run.driver}'s lap…`);
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
      setShareNote(null);
      await refresh();
      return true;
    } catch (e) {
      setShareNote(null);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [client, refresh]);

  const replay = useCallback((runId: string, ghostId: string | null) => {
    // A shared run has no files here yet; fetch it first, then it is a run
    // like any other.
    const run = allRunsRef.current.find((r) => r.runId === runId);
    const go = () => simLaunch({ replay: runId, ghost: ghostId ?? undefined })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    if (run?.remote) {
      void materialise(run).then((ok) => { if (ok) go(); });
      return;
    }
    void go();
  }, [materialise]);

  const openInLogs = useCallback((run: SimRun) => {
    const go = (path: string) => requestOpenInLogs([path], `${run.driver} — ${run.trackName}`);
    if (run.remote) {
      void materialise(run).then((ok) => {
        if (!ok) return;
        const local = allRunsRef.current.find((r) => r.runId === run.runId && !r.remote);
        if (local?.telemetryPath) go(local.telemetryPath);
      });
      return;
    }
    go(run.telemetryPath);
  }, [materialise]);

  /**
   * Start a drive with this run's best lap as the live delta's reference.
   *
   * Everything else about the launch comes from whatever the Launch tab is
   * set to, so "drive against this lap" changes one thing and leaves the
   * driver's own course, controls and aids alone -- except the course, which
   * has to be the one the reference was set on or the reference is nonsense.
   */
  const chase = useCallback((run: SimRun) => {
    if (!driver) { setError("Sign in to Helios to start a run."); return; }
    if (update.installing) { setError("The simulator is being updated; try again in a moment."); return; }
    // The launcher's own reader, not a second copy of it here.
    const prefs = readLaunchPrefs();
    // `run.track` comes off a manifest and can be anything -- a run whose
    // manifest had no track at all is listed as "unknown", and `as never`
    // walked that straight into `sim_launch`, which rejects it with an error
    // about a course nobody asked for. Fall back to the course the launcher
    // defaults to and let the driver pick.
    const track = isTrackId(run.track) ? run.track : TRACKS[0]!.id;
    const go = () => simLaunch({
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
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // The simulator reads the reference out of the runs directory -- it
    // builds its time-at-distance table from the lap's telemetry -- so a
    // shared run has to be brought here first, exactly as a replay does.
    if (run.remote) {
      void materialise(run).then((ok) => { if (ok) go(); });
      return;
    }
    void go();
  }, [driver, materialise, update.installing]);

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

  return (
    <div data-module="sim" className="relative flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex items-center gap-1 border-b border-helios-line px-3 py-2">
        <TabBtn active={tab === "launch"} onClick={() => selectTab("launch")} icon={<IconPlayerPlayFilled size={14} />}>
          Launch
        </TabBtn>
        <TabBtn active={tab === "runs"} onClick={() => selectTab("runs")} icon={<IconList size={14} />}>
          Runs
          {runs.length > 0 && <Count>{runs.length}</Count>}
        </TabBtn>
        <TabBtn active={tab === "board"} onClick={() => selectTab("board")} icon={<IconTrophy size={14} />}>
          Leaderboard
        </TabBtn>

        <div className="ml-auto flex items-center gap-3">
          {/* Visible from every tab: a driver on Runs should know the
              executable is changing under them before they press Replay. */}
          {update.installing && update.build && (
            <span className="rounded-full bg-asu-gold/15 px-2 py-0.5 text-[11px] text-asu-gold">
              Updating simulator to {update.build.version}
              {update.build.bytes ? ` · ${Math.min(100, (update.got / update.build.bytes) * 100).toFixed(0)}%` : ""}
            </span>
          )}
          {error && <span className="max-w-[420px] truncate text-xs text-helios-danger">{error}</span>}
          <button
            className="rounded p-1 text-helios-dim transition hover:text-helios-text"
            title="Re-read the run archive and sync with the team"
            onClick={() => { void refresh(); requestSync(); }}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-8 text-center text-sm text-helios-dim">Reading the run archive…</p>
          ) : tab === "launch" ? (
            <LaunchPanel
              status={status}
              driver={driver}
              onStatusChange={setStatus}
              onLaunched={() => { void refresh(); }}
              update={update}
            />
          ) : tab === "board" ? (
            <Leaderboard
              runs={allRuns}
              canReplay={canReplay}
              onOpenRun={(id) => { setSelectedId(id); selectTab("runs"); }}
              onReplayRun={(id) => replay(id, null)}
            />
          ) : (
            <RunsTable
              runs={allRuns}
              selectedId={selectedId}
              canReplay={canReplay}
              driverId={driver?.id ?? null}
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
            canReplay={canReplay}
            onClose={() => setSession(null)}
            onOpenRun={(id) => { setSelectedId(id); setSession(null); }}
            onReplay={(id) => { setSession(null); replay(id, null); }}
          />
        )}

        {tab === "runs" && selected && (
          <RunDetail
            run={selected}
            allRuns={allRuns}
            canReplay={canReplay}
            driverId={driver?.id ?? null}
            lapShared={driver && selected.driverId === driver.id ? sharedLapIds.has(selected.runId) : null}
            onClose={() => setSelectedId(null)}
            onReplay={(r, ghostId) => replay(r.runId, ghostId)}
            onOpenInLogs={openInLogs}
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
                  setShareNote(`could not remove it from the board: ${e instanceof Error ? e.message : String(e)}`);
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, icon, children,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition " +
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
