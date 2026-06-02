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
      </div>
    </PmRouterProvider>
  );
}
