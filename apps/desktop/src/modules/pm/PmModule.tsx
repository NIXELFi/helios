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

    const hydrateFrom = (ws: Workspace) => {
      const persisted = readPersistedActiveProject(uid);
      const activeProjectId =
        persisted && ws.projectData[persisted] ? persisted : defaultProjectId(ws.projects);
      usePmStore.getState().hydrate({
        projects: ws.projects,
        projectData: ws.projectData,
        activeProjectId,
        currentUserId: uid,
        baselineOrg: ws.baselineOrg,
        roles: ws.roles,
        client: c,
      });
    };

    // Expose an authoritative, awaitable full reload to the store so a
    // server-backed create (createProject → the admin-only RPC) can re-pull the
    // whole workspace the moment it commits — reusing this exact loadWorkspace +
    // hydrate path rather than a separate one. Unlike the background refresh()
    // below, this has no in-flight/epoch guard: it runs right after a committed
    // RPC, so there's no optimistic local edit to clobber, and it must not be
    // silently skipped. saveSnapshot keeps the cold-launch cache current.
    usePmStore.getState().registerReloadWorkspace(async () => {
      const ws = await loadWorkspace(c);
      hydrateFrom(ws);
      saveSnapshot(ws, uid, new Date().toISOString());
    });

    // 1. Stale-while-revalidate: paint instantly from the cached snapshot so PM
    //    cold-launch shows the last workspace sub-frame instead of a spinner.
    const cached = loadSnapshot(uid);
    if (cached) {
      hydrateFrom(cached);
      setPhase("ready");
    }

    // 2. Revalidate from the network, then refresh the cache for next launch.
    void (async () => {
      try {
        const ws = await loadWorkspace(c);
        if (!active) return;
        hydrateFrom(ws);
        saveSnapshot(ws, uid, new Date().toISOString());
        setPhase("ready");
      } catch (e) {
        if (!active) return;
        // Already painted from cache → keep it rather than wiping the screen on
        // a transient failure. Only hard-error on a cold start with no cache.
        if (!cached) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      active = false;
      // Drop the reload hook so a server-backed create can't fire against a
      // stale client/user after sign-out or a client swap.
      usePmStore.getState().registerReloadWorkspace(null);
    };
  }, [client, userId]);

  // Keep the workspace fresh without a full app reload, re-hydrating from the
  // `pm` schema so server-side changes (the activity-feed trigger, edits from
  // another session, computed fields) appear. Preserves the active project + UI
  // state, and SKIPS while a write is in flight so it never clobbers an
  // in-flight optimistic edit.
  //
  // Freshness comes from four signals instead of a blind 20s full re-pull:
  //   - REALTIME on the published pm tables (subscribePmRealtime) — the live
  //     path, so a teammate's task/milestone/comment edit lands near-instantly,
  //   - a cheap task/activity change-probe (fetchPmCursor) every PM_PROBE_MS —
  //     covers the UNpublished tables + any missed realtime event,
  //   - window focus — a full refresh (catches the long tail instantly), and
  //   - a slow full-rehydrate backstop (PM_BACKSTOP_MS) for the long tail while
  //     the window stays focused but idle.
  useEffect(() => {
    if (!client || !userId) return;
    const c = client;
    const uid = userId;
    let running = false;
    // Set when a refresh aborts because a write started/finished mid-fetch. We
    // can't just drop that refresh — the change that triggered it (a probe/
    // realtime/focus signal) would be lost until the next cycle. Instead we
    // re-arm one retry the moment all in-flight writes drain (see the store
    // subscription below), so the pending change lands promptly.
    let retryPending = false;
    async function refresh() {
      const st = usePmStore.getState();
      if (!st.hydrated || st.inFlightWrites > 0 || running) return;
      running = true;
      const epochBefore = st.writeEpoch;
      try {
        const ws = await loadWorkspace(c);
        const cur = usePmStore.getState();
        // Abort if any write started (and maybe finished) during the fetch — the
        // snapshot may predate it, so re-hydrating would clobber that edit.
        if (cur.inFlightWrites > 0 || cur.writeEpoch !== epochBefore) {
          retryPending = true;
          return;
        }
        const keep =
          cur.activeProjectId && ws.projectData[cur.activeProjectId]
            ? cur.activeProjectId
            : defaultProjectId(ws.projects);
        usePmStore.getState().hydrate({
          projects: ws.projects,
          projectData: ws.projectData,
          activeProjectId: keep,
          currentUserId: uid,
          baselineOrg: ws.baselineOrg,
          roles: ws.roles,
          client: c,
          // Background re-hydrate: don't wipe a pending "Change not saved" toast.
          preserveWriteError: true,
        });
        // Keep the cold-launch cache fresh. serializeSnapshot caps size, so a
        // huge workspace just isn't persisted rather than janking the write.
        saveSnapshot(ws, uid, new Date().toISOString());
        retryPending = false; // this refresh succeeded — nothing left to re-arm
      } catch {
        // transient refresh failure — the next focus/interval retries
      } finally {
        running = false;
      }
    }
    // Cheap baseline for the change-probe. A full refresh (focus/backstop)
    // resets it to null so the next probe re-baselines instead of firing a
    // redundant refresh for a change the full pull already captured.
    let prevCursor: PmCursor | null = null;
    async function probe() {
      const st = usePmStore.getState();
      // Mirror refresh()'s guards: don't probe before hydration, mid-write, or
      // while a refresh is already running.
      if (!st.hydrated || st.inFlightWrites > 0 || running) return;
      try {
        const next = await fetchPmCursor(c);
        if (pmCursorChanged(prevCursor, next)) {
          prevCursor = next;
          void refresh();
        } else {
          prevCursor = next;
        }
      } catch {
        // Probe failed — fall back to a full refresh so the safety net holds,
        // and re-baseline on the next good probe.
        prevCursor = null;
        void refresh();
      }
    }
    const fullRefresh = () => {
      prevCursor = null;
      void refresh();
    };

    const onFocus = fullRefresh;
    window.addEventListener("focus", onFocus);
    const probeInterval = window.setInterval(() => void probe(), PM_PROBE_MS);
    const backstopInterval = window.setInterval(fullRefresh, PM_BACKSTOP_MS);

    // Realtime is the live path: the published pm tables (tasks, comments,
    // dependencies, task_subteams, milestones, calendar_events, subteams) push
    // changes instantly, so a teammate's edit appears in well under a second
    // instead of waiting up to PM_PROBE_MS. Debounced into one guarded refresh()
    // so a burst coalesces; the probe/focus/backstop above remain the safety net
    // for the UNpublished tables and any missed events.
    let realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
    const onRealtime = () => {
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(() => {
        realtimeDebounce = null;
        fullRefresh();
      }, PM_REALTIME_DEBOUNCE_MS);
    };
    const unsubscribeRealtime = subscribePmRealtime(c, onRealtime);

    // Re-arm a refresh that was aborted mid-fetch by an in-flight write: the
    // moment all writes drain (inFlightWrites → 0) and a retry is pending, run
    // one full refresh so the change that triggered the aborted refresh isn't
    // dropped until the next probe/backstop tick.
    let lastInFlight = usePmStore.getState().inFlightWrites;
    const unsubscribeStore = usePmStore.subscribe((state) => {
      const now = state.inFlightWrites;
      if (lastInFlight > 0 && now === 0 && retryPending) {
        retryPending = false;
        fullRefresh();
      }
      lastInFlight = now;
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(probeInterval);
      window.clearInterval(backstopInterval);
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      unsubscribeRealtime();
      unsubscribeStore();
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
