import { useEffect, useState, type ReactNode } from "react";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";
import { hexToRgba } from "@helios/pm-ui";
import { loadWorkspace, type Workspace } from "@pm/lib/data";
import { fetchPmCursor, pmCursorChanged, type PmCursor } from "@pm/lib/workspace-cursor";
import { subscribePmRealtime } from "@pm/lib/pm-realtime";
import { loadSnapshot, saveSnapshot } from "@pm/lib/workspace-snapshot";
import { SubteamThemeProvider, useSubteamTheme } from "@pm/lib/subteamTheme";
import { readPersistedActiveProject, usePmStore } from "@pm/lib/pmStore";
import { PmRouterProvider, usePathname } from "@pm/lib/router";
import { activeTeamSlug, activeViewSegment, activeWorkspace, recallScopeView, scopeKey } from "@pm/lib/nav";
import { Sidebar } from "@pm/components/Sidebar";
import { TaskDetailSheet } from "@pm/components/TaskDetailSheet";
import { DeadlineReportWindow } from "@pm/components/DeadlineReportWindow";
import { DashboardViewClient } from "@pm/views/DashboardViewClient";
import { TableViewClient } from "@pm/views/TableViewClient";
import { BoardViewClient } from "@pm/views/BoardViewClient";
import { GanttViewClient } from "@pm/views/GanttViewClient";
import { GraphViewClient } from "@pm/views/GraphViewClient";
import { CalendarViewClient } from "@pm/views/CalendarViewClient";
import { ActivityFeedClient } from "@pm/views/ActivityFeedClient";
import "./pm.css";

// Cheap task-change probe cadence — keeps task churn feeling live (~20s)
// without re-pulling the whole workspace every cycle.
const PM_PROBE_MS = 20_000;
// Slow full re-hydrate backstop. The cheap probe only tracks tasks/activity, so
// this catches the long tail (milestone/vendor/event/page edits, which have no
// cheap change signal) while the window stays focused but idle. Window focus
// also forces a full refresh, so an active user never waits this long.
const PM_BACKSTOP_MS = 180_000;
// Coalesce a burst of realtime events (e.g. a multi-row edit, or tasks +
// task_subteams firing together) into one re-hydrate. Short enough to still feel
// instant.
const PM_REALTIME_DEBOUNCE_MS = 150;

// Colored backdrop "aura" that tints the active view in the current scope's
// identity color (subteam color, or ASU maroon+gold for all-subteams). Purely
// decorative, sits behind the view content so it's instantly clear which
// subteam you're in.
function ScopeAura() {
  const { primary, secondary, isAllTeams } = useSubteamTheme();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 0 }} aria-hidden>
      <div
        className="pm-aura pm-aura-tl"
        style={{ background: `radial-gradient(circle at center, ${hexToRgba(primary, 0.2)} 0%, transparent 62%)` }}
      />
      <div
        className="pm-aura pm-aura-br"
        style={{
          background: `radial-gradient(circle at center, ${hexToRgba(isAllTeams ? secondary : primary, isAllTeams ? 0.16 : 0.12)} 0%, transparent 62%)`,
        }}
      />
      <div
        className="pm-aura pm-aura-glow"
        style={{ background: `radial-gradient(circle at center, ${hexToRgba(primary, 0.1)} 0%, transparent 70%)` }}
      />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-helios-base px-6 text-center text-sm text-helios-dim">
      {children}
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return <Centered>{label} is coming to the desktop PM tab soon.</Centered>;
}

// Reads the local router pathname and renders the matching PM view. Replaces
// the Next.js file-based routes.
function CurrentView() {
  const pathname = usePathname();
  const ws = activeWorkspace(pathname);
  const teamSlug = activeTeamSlug(pathname);
  const view = activeViewSegment(pathname) ?? "table";

  if (ws === "build") return <ComingSoon label="The Build workspace" />;
  if (ws === "compete") return <ComingSoon label="Competition planning" />;

  switch (view) {
    case "dashboard":
      // Keyed per scope: the dashboard's shared-layout state (fetch, dirty
      // tracking, pending saves) must be a fresh instance per scope, not a
      // prop change — see useSharedDashboardLayout.ts.
      return <DashboardViewClient key={scopeKey(teamSlug)} teamSlug={teamSlug} />;
    case "board":
      return <BoardViewClient teamSlug={teamSlug} />;
    case "gantt":
      return <GanttViewClient teamSlug={teamSlug} />;
    case "graph":
      return <GraphViewClient teamSlug={teamSlug} />;
    case "calendar":
      return <CalendarViewClient teamSlug={teamSlug} />;
    case "activity":
      return <ActivityFeedClient teamSlug={teamSlug} />;
    case "pages":
      return <ComingSoon label="The Pages editor" />;
    case "table":
    default:
      return <TableViewClient teamSlug={teamSlug} />;
  }
}

// Returns true when keyboard focus is inside an editable element, so the global
// undo/redo shortcut yields to native text-field undo there.
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

// Global Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo) for task edits. Routed
// through the store's command stack so it reverses both inline and bulk edits.
// Mounted once; no UI of its own.
function UndoRedoHotkeys() {
  const undo = usePmStore((s) => s.undo);
  const redo = usePmStore((s) => s.redo);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      if (isEditableTarget(e.target)) return; // let text fields undo themselves
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  return null;
}

// Surfaces a failed write (optimistic change rolled back) as a dismissible
// toast. Auto-clears after a few seconds so it never lingers.
function WriteErrorToast() {
  const error = usePmStore((s) => s.lastWriteError);
  const clear = usePmStore((s) => s.clearWriteError);
  const retryReload = usePmStore((s) => s.retryWriteErrorReload);
  useEffect(() => {
    if (!error) return;
    // A partial write leaves the screen disagreeing with the server until the
    // forced reload lands, so this toast must NOT time out — it's the only
    // signal that what's on screen was rewritten under the user. Everything
    // else self-clears as before.
    if (error.needsReload) return;
    const t = setTimeout(clear, 6000);
    return () => clearTimeout(t);
  }, [error, clear]);
  if (!error) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-red-500/40 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-lg">
      <div className="font-medium">
        {error.needsReload ? "Only part of that saved" : "Change not saved"}
      </div>
      <div className="mt-0.5 break-words text-red-200/80">{error.message}</div>
      {error.needsReload && (
        <div className="mt-1.5 text-xs text-red-200/70">
          {error.reload === "pending" && "Reloading from the server…"}
          {error.reload === "done" && "Reloaded — this is what actually saved."}
          {error.reload === "failed" && "Reload failed — what you see may be out of date."}
        </div>
      )}
      <div className="mt-1.5 flex gap-3">
        {error.needsReload && error.reload !== "pending" && (
          <button
            type="button"
            onClick={retryReload}
            className="text-xs font-medium text-red-200 underline underline-offset-2 hover:text-red-100"
          >
            {error.reload === "failed" ? "Reload now" : "Reload again"}
          </button>
        )}
        <button
          type="button"
          onClick={clear}
          className="text-xs text-red-300 underline underline-offset-2 hover:text-red-200"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Mounts the Deadlines report window, driven by the session-only store flag the
// Sidebar button toggles. Kept as its own subscriber so the rest of PmModule
// doesn't re-render when the window opens/closes.
function DeadlineReportHost() {
  const reportOpen = usePmStore((s) => s.reportOpen);
  const setReportOpen = usePmStore((s) => s.setReportOpen);
  return <DeadlineReportWindow open={reportOpen} onClose={() => setReportOpen(false)} />;
}

// Default project when the user has no persisted selection: the newest season
// by NATURAL name order ("SDM27" beats "SDM26", and a future "SDM28" will beat
// both) — DB row order put SDM26 first, which is how new users ended up
// creating tasks in last year's project. A persisted selection always wins.
function defaultProjectId(projects: ReadonlyArray<{ id: string; name: string }>): string {
  if (projects.length === 0) return "";
  return [...projects].sort((a, b) =>
    b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" }),
  )[0]!.id;
}

// The PM desktop module. Mounted by the Shell only when a user is signed in
// (same gate as Vault), so the shared Supabase client + session are available.
// Loads the workspace from the `pm` schema, hydrates the store, then renders the
// PM UI with a local router.
export function PmModule() {
  const client = useSupabaseClientOrNull();
  const user = useUser();
  // Key the effects below on the user's ID, NOT the user object — the same
  // hazard useMyRole (AuthShell) already guards. onAuthStateChange hands the
  // provider a fresh `user` object on every benign event (incl. the ~hourly
  // TOKEN_REFRESHED), and depending on `user` would re-run both effects: the
  // first would re-`hydrateFrom(loadSnapshot(...))` mid-session, replacing the
  // whole store from a possibly-stale localStorage snapshot (visibly reverting
  // recent edits and desynchronising any in-flight rollback pre-image), and the
  // second would tear down and re-subscribe the realtime channel + both
  // intervals. Neither effect body needs anything from `user` but its id.
  const userId = user?.id ?? null;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !userId) return;
    const c = client;
    const uid = userId;
    let active = true;
    let running: Promise<void> | null = null;
    let requested = false;
    let releaseWriteWait: (() => void) | null = null;
    let hasWorkspace = false;

    const hydrateFrom = (ws: Workspace) => {
      const cur = usePmStore.getState();
      const selected = hasWorkspace && cur.currentUserId === uid
        ? cur.activeProjectId : readPersistedActiveProject(uid);
      const activeProjectId = selected && ws.projectData[selected]
        ? selected : defaultProjectId(ws.projects);
      cur.hydrate({
        projects: ws.projects, projectData: ws.projectData, activeProjectId,
        currentUserId: uid, baselineOrg: ws.baselineOrg, roles: ws.roles, client: c,
        preserveWriteError: hasWorkspace,
      });
      hasWorkspace = true;
      setPhase("ready");
    };

    setError(null);
    setPhase("loading");
    const cached = loadSnapshot(uid);
    if (cached) hydrateFrom(cached);

    // Every load path (startup, explicit reload, realtime, focus, probe) shares
    // the same owner lifetime and write-epoch gate. Waiting is event-driven:
    // a write that already finished during a fetch must also trigger a retry.
    function waitForWrites(): Promise<void> {
      if (!active || usePmStore.getState().inFlightWrites === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          unsubscribe();
          releaseWriteWait = null;
          resolve();
        };
        const unsubscribe = usePmStore.subscribe((state) => {
          if (state.inFlightWrites === 0) finish();
        });
        releaseWriteWait = finish;
      });
    }

    function requestRefresh(): Promise<void> {
      if (!active) return Promise.resolve();
      requested = true;
      if (running) return running;
      running = (async () => {
        while (active && requested) {
          requested = false;
          await waitForWrites();
          if (!active) return;
          const epoch = usePmStore.getState().writeEpoch;
          const ws = await loadWorkspace(c);
          if (!active) return;
          const cur = usePmStore.getState();
          if (cur.inFlightWrites > 0 || cur.writeEpoch !== epoch) {
            requested = true;
            continue;
          }
          hydrateFrom(ws);
          saveSnapshot(ws, uid, new Date().toISOString());
        }
      })().finally(() => { running = null; });
      return running;
    }

    const refreshSafely = () => {
      void requestRefresh().catch((e: unknown) => {
        if (!active || hasWorkspace) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
    };
    usePmStore.getState().registerReloadWorkspace(requestRefresh);
    refreshSafely();

    let prevCursor: PmCursor | null = null;
    async function probe() {
      if (!active || running || usePmStore.getState().inFlightWrites > 0) return;
      try {
        const next = await fetchPmCursor(c);
        if (!active) return;
        if (pmCursorChanged(prevCursor, next)) refreshSafely();
        prevCursor = next;
      } catch {
        if (!active) return;
        prevCursor = null;
        refreshSafely();
      }
    }
    const fullRefresh = () => {
      prevCursor = null;
      refreshSafely();
    };
    window.addEventListener("focus", fullRefresh);
    const probeInterval = window.setInterval(() => void probe(), PM_PROBE_MS);
    const backstopInterval = window.setInterval(fullRefresh, PM_BACKSTOP_MS);
    let realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeRealtime = subscribePmRealtime(c, () => {
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(() => {
        realtimeDebounce = null;
        fullRefresh();
      }, PM_REALTIME_DEBOUNCE_MS);
    });

    return () => {
      // Invalidate before releasing waiters: an old request may complete after
      // the next user has already hydrated this singleton store.
      active = false;
      releaseWriteWait?.();
      if (usePmStore.getState().reloadWorkspace === requestRefresh) {
        usePmStore.getState().registerReloadWorkspace(null);
      }
      window.removeEventListener("focus", fullRefresh);
      window.clearInterval(probeInterval);
      window.clearInterval(backstopInterval);
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      unsubscribeRealtime();
    };
  }, [client, userId]);

  if (phase === "loading") return <Centered>Loading your projects…</Centered>;
  if (phase === "error")
    return (
      <Centered>
        <span className="text-red-300">Could not load PM data: {error}</span>
      </Centered>
    );

  return (
    // Reopen the project's last-used view (rememberScopeView, written by the
    // Sidebar on every navigation) instead of always landing on the table.
    <PmRouterProvider initialPath={`/${recallScopeView(null) ?? "table"}`}>
      <div className="pm-root flex h-full w-full overflow-hidden bg-helios-base text-helios-text">
        <Sidebar />
        <SubteamThemeProvider>
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ScopeAura />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <CurrentView />
            </div>
          </main>
        </SubteamThemeProvider>
        <TaskDetailSheet />
        <DeadlineReportHost />
        <WriteErrorToast />
        <UndoRedoHotkeys />
      </div>
    </PmRouterProvider>
  );
}
