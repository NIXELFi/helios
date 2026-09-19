import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconList, IconPlayerPlayFilled, IconRefresh, IconTrophy,
} from "@tabler/icons-react";
import { useHeliosAuth, userDisplayName } from "../../auth/AuthShell";
import { requestOpenInLogs } from "../../lib/open-in-logs";
import { LaunchPanel, readLaunchPrefs } from "./components/LaunchPanel";
import { Leaderboard } from "./components/Leaderboard";
import { RunDetail } from "./components/RunDetail";
import { RunsTable } from "./components/RunsTable";
import { SessionSummary, runsInSession, type SessionWindow } from "./components/SessionSummary";
import { listen } from "@tauri-apps/api/event";
import { simLaunch, simListRuns, simStatus, type SimRun, type SimStatus,
  TRACKS, type TrackId,
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
  const { user } = useHeliosAuth();
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
  const [runs, setRuns] = useState<SimRun[]>([]);
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
    () => runs.find((r) => r.runId === selectedId) ?? null,
    [runs, selectedId],
  );
  const canReplay = !!status?.exePath;

  const replay = useCallback((runId: string, ghostId: string | null) => {
    simLaunch({ replay: runId, ghost: ghostId ?? undefined })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const openInLogs = useCallback((run: SimRun) => {
    requestOpenInLogs([run.telemetryPath], `${run.driver} — ${run.trackName}`);
  }, []);

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
    // The launcher's own reader, not a second copy of it here.
    const prefs = readLaunchPrefs();
    // `run.track` comes off a manifest and can be anything -- a run whose
    // manifest had no track at all is listed as "unknown", and `as never`
    // walked that straight into `sim_launch`, which rejects it with an error
    // about a course nobody asked for. Fall back to the course the launcher
    // defaults to and let the driver pick.
    const track = TRACKS.some((t) => t.id === run.track)
      ? (run.track as TrackId)
      : TRACKS[0]!.id;
    simLaunch({
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
  }, [driver]);

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
          {error && <span className="max-w-[420px] truncate text-xs text-helios-danger">{error}</span>}
          <button
            className="rounded p-1 text-helios-dim transition hover:text-helios-text"
            title="Re-read the run archive"
            onClick={() => void refresh()}
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
            />
          ) : tab === "board" ? (
            <Leaderboard
              runs={runs}
              canReplay={canReplay}
              onOpenRun={(id) => { setSelectedId(id); selectTab("runs"); }}
              onReplayRun={(id) => replay(id, null)}
            />
          ) : (
            <RunsTable
              runs={runs}
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
            allRuns={runs}
            canReplay={canReplay}
            onClose={() => setSession(null)}
            onOpenRun={(id) => { setSelectedId(id); setSession(null); }}
            onReplay={(id) => { setSession(null); replay(id, null); }}
          />
        )}

        {tab === "runs" && selected && (
          <RunDetail
            run={selected}
            allRuns={runs}
            canReplay={canReplay}
            canDrive={!!driver}
            onClose={() => setSelectedId(null)}
            onReplay={(r, ghostId) => replay(r.runId, ghostId)}
            onOpenInLogs={openInLogs}
            onChase={chase}
            onDeleted={(id) => {
              setSelectedId(null);
              // Invalidate any refresh already in flight, so its older listing
              // cannot put this row back.
              seq.current += 1;
              setRuns((prev) => prev.filter((r) => r.runId !== id));
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
