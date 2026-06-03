import { useEffect, useState, type ReactNode } from "react";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";
import { loadWorkspace } from "@pm/lib/data";
import { readPersistedActiveProject, usePmStore } from "@pm/lib/pmStore";
import { PmRouterProvider, usePathname } from "@pm/lib/router";
import { activeTeamSlug, activeViewSegment, activeWorkspace } from "@pm/lib/nav";
import { Sidebar } from "@pm/components/Sidebar";
import { TaskDetailSheet } from "@pm/components/TaskDetailSheet";
import { TableViewClient } from "@pm/views/TableViewClient";
import { BoardViewClient } from "@pm/views/BoardViewClient";
import { GanttViewClient } from "@pm/views/GanttViewClient";
import { GraphViewClient } from "@pm/views/GraphViewClient";
import { CalendarViewClient } from "@pm/views/CalendarViewClient";
import { ActivityFeedClient } from "@pm/views/ActivityFeedClient";
import "./pm.css";

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
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clear, 6000);
    return () => clearTimeout(t);
  }, [error, clear]);
  if (!error) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-red-500/40 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-lg">
      <div className="font-medium">Change not saved</div>
      <div className="mt-0.5 break-words text-red-200/80">{error.message}</div>
      <button
        type="button"
        onClick={clear}
        className="mt-1.5 text-xs text-red-300 underline underline-offset-2 hover:text-red-200"
      >
        Dismiss
      </button>
    </div>
  );
}

// The PM desktop module. Mounted by the Shell only when a user is signed in
// (same gate as Vault), so the shared Supabase client + session are available.
// Loads the workspace from the `pm` schema, hydrates the store, then renders the
// PM UI with a local router.
export function PmModule() {
  const client = useSupabaseClientOrNull();
  const user = useUser();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !user) return;
    let active = true;
    void (async () => {
      try {
        const ws = await loadWorkspace(client);
        if (!active) return;
        const persisted = readPersistedActiveProject();
        const firstId = ws.projects[0]?.id ?? "";
        const activeProjectId =
          persisted && ws.projectData[persisted] ? persisted : firstId;
        usePmStore.getState().hydrate({
          projects: ws.projects,
          projectData: ws.projectData,
          activeProjectId,
          currentUserId: user.id,
          baselineOrg: ws.baselineOrg,
          client,
        });
        setPhase("ready");
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [client, user]);

  // Keep the workspace fresh without a full app reload: re-fetch on window focus
  // and on a short interval, re-hydrating from the `pm` schema so server-side
  // changes (the activity-feed trigger, edits from another session, computed
  // fields) appear. Preserves the active project + UI state, and SKIPS while a
  // write is in flight so it never clobbers an in-flight optimistic edit.
  useEffect(() => {
    if (!client || !user) return;
    const c = client;
    const u = user;
    let running = false;
    async function refresh() {
      const st = usePmStore.getState();
      if (!st.hydrated || st.inFlightWrites > 0 || running) return;
      running = true;
      try {
        const ws = await loadWorkspace(c);
        const cur = usePmStore.getState();
        if (cur.inFlightWrites > 0) return; // a write started during the fetch
        const keep =
          cur.activeProjectId && ws.projectData[cur.activeProjectId]
            ? cur.activeProjectId
            : ws.projects[0]?.id ?? "";
        usePmStore.getState().hydrate({
          projects: ws.projects,
          projectData: ws.projectData,
          activeProjectId: keep,
          currentUserId: u.id,
          baselineOrg: ws.baselineOrg,
          client: c,
        });
      } catch {
        // transient refresh failure — the next focus/interval retries
      } finally {
        running = false;
      }
    }
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void refresh(), 20000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [client, user]);

  if (phase === "loading") return <Centered>Loading your projects…</Centered>;
  if (phase === "error")
    return (
      <Centered>
        <span className="text-red-300">Could not load PM data: {error}</span>
      </Centered>
    );

  return (
    <PmRouterProvider initialPath="/table">
      <div className="pm-root flex h-full w-full bg-helios-base text-helios-text">
        <Sidebar />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CurrentView />
        </main>
        <TaskDetailSheet />
        <WriteErrorToast />
        <UndoRedoHotkeys />
      </div>
    </PmRouterProvider>
  );
}
