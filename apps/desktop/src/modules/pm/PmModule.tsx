import { useEffect, useRef, useState, type ReactNode } from "react";
import { Splash } from "../../components/Splash";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";
import { useModuleLive } from "../../shell/module-activity";
import { useThrottledFocus } from "../../lib/use-throttled-focus";
import { hexToRgba } from "@helios/pm-ui";
import {
  buildWorkspace,
  fetchTaskRowsByIds,
  fetchWorkspaceRaw,
  type RawWorkspace,
  type Workspace,
} from "@pm/lib/data";
import { applyPmEvents, pmEventFrom, spliceTaskRows, type PmEvent } from "@pm/lib/pm-apply";
import { fetchPmCursor, pmCursorChanged, type PmCursor } from "@pm/lib/workspace-cursor";
import { subscribePmRealtime, type PmRealtimeEvent } from "@pm/lib/pm-realtime";
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
import { ProductivityViewClient } from "@pm/views/ProductivityViewClient";
import "./pm.css";

// Cheap task-change probe cadence — keeps task churn feeling live (~20s)
// without re-pulling the whole workspace every cycle.
const PM_PROBE_MS = 20_000;
// Slow full re-hydrate backstop. The cheap probe only tracks tasks/activity, so
// this catches the long tail (milestone/vendor/event/page edits, which have no
// cheap change signal) while PM is on screen but idle. Realtime is the live
// path for all of those tables, so this really is a backstop — at 3 minutes it
// was re-pulling the whole workspace 20 times an hour per idle client for
// nothing (load audit 2026-09-09). It only ticks while PM is live.
const PM_BACKSTOP_MS = 600_000;
// Coalesce a burst of realtime events (e.g. a multi-row edit, or tasks +
// task_subteams firing together) into one re-hydrate. Short enough to still feel
// instant.
const PM_REALTIME_DEBOUNCE_MS = 150;
// Persisting the cold-launch snapshot means JSON.stringify-ing the whole
// workspace. At one write per applied event that is pure jank, so writes are
// trailing-debounced and flushed on unmount.
const PM_SNAPSHOT_DEBOUNCE_MS = 2_000;
// How many realtime events to buffer while PM is off screen. Past this, replaying
// them is no cheaper than one full pull, so we stop buffering and mark the
// workspace stale (the re-activation effect then refreshes).
const PM_HIDDEN_EVENT_CAP = 50;

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
    case "productivity":
      // Keyed per scope: the view owns its own fetch + range state, and a scope
      // switch must start that over rather than re-filter a stale window.
      return <ProductivityViewClient key={scopeKey(teamSlug)} teamSlug={teamSlug} />;
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

  // "Is PM the module on screen, in a visible window?" The Shell keeps every
  // visited module mounted, so without this a backgrounded PM kept probing and
  // full-refreshing forever. Mirrored into a ref so the long-lived effect below
  // reads the current value without re-subscribing realtime on every flip.
  const live = useModuleLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  // Set when PM is not live and the buffered events below can't carry the
  // change (the buffer overflowed): don't re-pull in the background, just
  // remember the workspace moved and do ONE full refresh on return.
  const staleWhileHiddenRef = useRef(false);
  // Realtime events that arrived while PM was off screen, replayed through the
  // incremental path on return so a background module costs zero requests while
  // hidden and (usually) one on the way back.
  const hiddenEventsRef = useRef<PmEvent[]>([]);
  // The last raw rows the server gave us, with the store's writeEpoch at the
  // moment they were adopted. Keeping them lets a teammate's edit be applied
  // locally (applyPmEvents → buildWorkspace) instead of re-pulling the whole
  // workspace on every event — the load audit measured ~1,650 of those full
  // pulls a day.
  //
  // Null until the first NETWORK load resolves: a cold launch paints from the
  // built snapshot, which cannot be un-built, so the incremental path falls
  // back to a full refresh while this is null. The epoch is the other half of
  // that safety: writes to the UNPUBLISHED pm tables (vendors, subsystems,
  // projects, build records) never echo over realtime, so once the store has
  // committed one, rebuilding from these rows would silently revert it —
  // a moved epoch means "re-pull once before trusting the cache again".
  const rawRef = useRef<{ raw: RawWorkspace; epoch: number } | null>(null);
  // The refresh effect publishes its three entry points here so the
  // re-activation effect and the focus handler can reach them.
  const probeRef = useRef<(() => Promise<void>) | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const applyEventsRef = useRef<((events: PmEvent[]) => void) | null>(null);

  // Trailing-debounced snapshot write, shared by every path that produces a
  // workspace. flushSnapshot() runs it immediately (unmount) so the cold-launch
  // cache is never left behind by a pending timer.
  const snapshotRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: { ws: Workspace; uid: string } | null;
  }>({ timer: null, pending: null });
  const flushSnapshot = () => {
    const s = snapshotRef.current;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const pending = s.pending;
    s.pending = null;
    if (pending) saveSnapshot(pending.ws, pending.uid, new Date().toISOString());
  };
  const saveSnapshotDebounced = (ws: Workspace, uid: string) => {
    const s = snapshotRef.current;
    s.pending = { ws, uid };
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      flushSnapshot();
    }, PM_SNAPSHOT_DEBOUNCE_MS);
  };
  useEffect(() => flushSnapshot, []);

  // Window focus used to force a FULL workspace pull, on every alt-tab, with no
  // throttle. The cheap probe detects task churn and the backstop covers the
  // long tail, so a returning user costs one small request at most every 15 s.
  useThrottledFocus(() => {
    void probeRef.current?.();
  }, 15_000);

  // Catch up when PM comes back on screen (module re-activated, or the window
  // un-hidden): replay whatever realtime buffered while we were away (0 or 1
  // request), a cheap probe if nothing arrived, and a full refresh only if the
  // buffer overflowed.
  const wasLiveRef = useRef(live);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;
    if (!live || wasLive) return;
    const buffered = hiddenEventsRef.current;
    hiddenEventsRef.current = [];
    const stale = staleWhileHiddenRef.current;
    staleWhileHiddenRef.current = false;
    const applyEvents = applyEventsRef.current;
    if (stale || (buffered.length > 0 && !applyEvents)) {
      refreshRef.current?.();
    } else if (buffered.length > 0 && applyEvents) {
      applyEvents(buffered);
    } else {
      void probeRef.current?.();
    }
  }, [live]);

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
      const raw = await fetchWorkspaceRaw(c);
      const ws = buildWorkspace(raw);
      rawRef.current = { raw, epoch: usePmStore.getState().writeEpoch };
      hydrateFrom(ws);
      saveSnapshotDebounced(ws, uid);
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
        const raw = await fetchWorkspaceRaw(c);
        if (!active) return;
        const ws = buildWorkspace(raw);
        rawRef.current = { raw, epoch: usePmStore.getState().writeEpoch };
        hydrateFrom(ws);
        saveSnapshotDebounced(ws, uid);
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
      // The cached rows belong to THIS user under THIS client. Drop them so the
      // incremental path can't apply a new session's events to them.
      rawRef.current = null;
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
  //   - window focus — one throttled probe (see useThrottledFocus above), and
  //   - a slow full-rehydrate backstop (PM_BACKSTOP_MS) for the long tail while
  //     PM stays on screen but idle.
  //
  // All four stand down while PM isn't live (another module is on screen, or
  // the window is hidden): the timers no-op and realtime only BUFFERS its
  // payloads, which the re-activation effect above replays incrementally.
  useEffect(() => {
    if (!client || !userId) return;
    const c = client;
    const uid = userId;
    // Guards every async continuation below: the effect is torn down on
    // sign-out and on a client swap, and a fetch that was already in flight
    // must not hydrate the store afterwards.
    let active = true;
    let running = false;
    // Set when a refresh aborts because a write started/finished mid-fetch. We
    // can't just drop that refresh — the change that triggered it (a probe/
    // realtime/focus signal) would be lost until the next cycle. Instead we
    // re-arm one retry the moment all in-flight writes drain (see the store
    // subscription below), so the pending change lands promptly.
    let retryPending = false;

    // Push a freshly built workspace into the store, preserving the active
    // project and any pending write-error toast. Shared by the full refresh and
    // the incremental apply so both hydrate identically.
    const hydrateBackground = (ws: Workspace) => {
      const cur = usePmStore.getState();
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
      saveSnapshotDebounced(ws, uid);
    };

    async function refresh() {
      const st = usePmStore.getState();
      if (!st.hydrated || st.inFlightWrites > 0 || running) return;
      running = true;
      const epochBefore = st.writeEpoch;
      try {
        const raw = await fetchWorkspaceRaw(c);
        // Sign-out / client swap while the pull was in flight.
        if (!active) return;
        const cur = usePmStore.getState();
        // Abort if any write started (and maybe finished) during the fetch — the
        // snapshot may predate it, so re-hydrating would clobber that edit.
        if (cur.inFlightWrites > 0 || cur.writeEpoch !== epochBefore) {
          retryPending = true;
          return;
        }
        const ws = buildWorkspace(raw);
        rawRef.current = { raw, epoch: cur.writeEpoch };
        hydrateBackground(ws);
        retryPending = false; // this refresh succeeded — nothing left to re-arm
      } catch {
        // transient refresh failure — the next focus/interval retries
      } finally {
        running = false;
      }
    }

    /**
     * The live path: rebuild the workspace from the cached raw rows plus the
     * realtime payloads, so a teammate's edit costs this client 0 requests for a
     * flat table and 1 (the changed task rows, with their embeds) for a task —
     * instead of the full ~17-read pull every event used to trigger.
     *
     * Falls back to refresh() whenever the events can't be applied safely: no
     * raw cache yet (cold launch painted from the snapshot), an unknown table,
     * or a DELETE whose old row didn't carry its key.
     */
    async function applyIncremental(events: PmEvent[]) {
      if (events.length === 0) return;
      const st = usePmStore.getState();
      // Same guards as refresh(). Unlike a probe-driven refresh, dropping these
      // events would LOSE the change, so re-arm a retry instead of returning.
      if (!st.hydrated || st.inFlightWrites > 0 || running) {
        retryPending = true;
        return;
      }
      const cached = rawRef.current;
      // No cache yet (cold launch painted from the snapshot), or the store has
      // committed a local write these rows never saw — a write to one of the
      // UNPUBLISHED tables never echoes back, so rebuilding from the cache
      // would revert it on screen. One full pull re-syncs both.
      if (!cached || cached.epoch !== st.writeEpoch) {
        void refresh();
        return;
      }
      const applied = applyPmEvents(cached.raw, events);
      if (applied.full) {
        fullRefresh();
        return;
      }
      running = true;
      const epochBefore = st.writeEpoch;
      try {
        let next = applied.raw;
        if (applied.refetchTaskIds.length > 0) {
          const rows = await fetchTaskRowsByIds(c, applied.refetchTaskIds);
          if (!active) return;
          const cur = usePmStore.getState();
          if (cur.inFlightWrites > 0 || cur.writeEpoch !== epochBefore) {
            retryPending = true;
            return;
          }
          next = spliceTaskRows(next, applied.refetchTaskIds, rows);
        }
        if (next === cached.raw) return; // nothing actually moved
        rawRef.current = { raw: next, epoch: epochBefore };
        hydrateBackground(buildWorkspace(next));
        retryPending = false;
      } catch {
        // The task re-read failed. The cursor probe tracks exactly these tables
        // (tasks/activity/owners/links), so its next tick sees the signature
        // move and runs a full refresh; re-arm the write-drain retry too.
        if (active) retryPending = true;
      } finally {
        running = false;
      }
    }
    // Cheap baseline for the change-probe. A full refresh (focus/backstop)
    // resets it to null so the next probe re-baselines instead of firing a
    // redundant refresh for a change the full pull already captured.
    let prevCursor: PmCursor | null = null;
    async function probe() {
      // Hidden module / hidden window: nothing is on screen to keep fresh.
      if (!liveRef.current) return;
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

    // Publish the three entry points for the focus handler and the re-activation
    // effect at component scope (both live outside this effect's closure).
    probeRef.current = probe;
    refreshRef.current = fullRefresh;
    applyEventsRef.current = (events: PmEvent[]) => void applyIncremental(events);

    const probeInterval = window.setInterval(() => void probe(), PM_PROBE_MS);
    const backstopInterval = window.setInterval(() => {
      if (!liveRef.current) return;
      fullRefresh();
    }, PM_BACKSTOP_MS);

    // Realtime is the live path: the published pm tables (tasks, comments,
    // dependencies, task_subteams, milestones, calendar_events, subteams) push
    // changes instantly, so a teammate's edit appears in well under a second
    // instead of waiting up to PM_PROBE_MS. The payloads are APPLIED to the
    // cached rows (applyIncremental) rather than triggering a full re-pull;
    // the probe/focus/backstop above remain the safety net for the UNpublished
    // tables and any missed events. Debounced so a burst (tasks +
    // task_subteams + activity for one edit) coalesces into one rebuild.
    let realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
    let pendingEvents: PmEvent[] = [];
    // Off screen: nothing would repaint, and every client in the org gets this
    // event at once. Hold the events and replay them on return. Past the cap,
    // one full pull is cheaper than the backlog, so drop it and mark stale.
    const bufferWhileHidden = (events: PmEvent[]) => {
      if (staleWhileHiddenRef.current) return; // already owed a full refresh
      const buffered = hiddenEventsRef.current;
      if (buffered.length + events.length > PM_HIDDEN_EVENT_CAP) {
        hiddenEventsRef.current = [];
        staleWhileHiddenRef.current = true;
        return;
      }
      buffered.push(...events);
    };
    const onRealtime = (e: PmRealtimeEvent) => {
      const event = pmEventFrom(e.table, e.payload);
      if (!liveRef.current) {
        bufferWhileHidden([event]);
        return;
      }
      pendingEvents.push(event);
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(() => {
        realtimeDebounce = null;
        const batch = pendingEvents;
        pendingEvents = [];
        // PM may have gone off screen inside the debounce window.
        if (!liveRef.current) {
          bufferWhileHidden(batch);
          return;
        }
        void applyIncremental(batch);
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
      active = false;
      probeRef.current = null;
      refreshRef.current = null;
      applyEventsRef.current = null;
      // Buffered events belong to the session that just ended.
      hiddenEventsRef.current = [];
      staleWhileHiddenRef.current = false;
      window.clearInterval(probeInterval);
      window.clearInterval(backstopInterval);
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      unsubscribeRealtime();
      unsubscribeStore();
    };
  }, [client, userId]);

  if (phase === "loading") return <Splash stage="Loading your projects…" animate={false} />;
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
