import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "../src/modules/pm/pm.css";
import { PmRouterProvider } from "@pm/lib/router";
import { usePmStore } from "@pm/lib/pmStore";
import { BoardViewClient } from "@pm/views/BoardViewClient";
import { TableViewClient } from "@pm/views/TableViewClient";

const uuid = (n: number, tag: string) =>
  `${tag.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const qs = new URLSearchParams(location.search);
const N = Number(qs.get("tasks") ?? "234");
const NDEPS = Number(qs.get("deps") ?? "213");
const WITH_AURA = qs.get("aura") !== "0";
const VIEW = qs.get("view") ?? "board";
// A/B switch for the board-card containment (pm-board-card in pm.css).
if (qs.get("cv") === "0") {
  const st = document.createElement("style");
  st.textContent = ".pm-board-card{content-visibility:visible!important;contain-intrinsic-size:auto!important}";
  document.head.appendChild(st);
}

const subteams = Array.from({ length: 16 }, (_, i) => ({
  id: uuid(i, "st"), name: `Subteam ${i}`, code: `S${i}`,
  slug: `subteam-${i}`, color: "#8899aa", icon: null,
}));
const users = Array.from({ length: 138 }, (_, i) => ({
  id: uuid(i, "us"), name: `User Number ${i}`, email: `u${i}@asu.edu`,
  avatar_url: null, role: "engineer", subteam_id: null,
}));
const statuses = ["not_started", "in_progress", "needs_review", "blocked", "done"];
const tasks = Array.from({ length: N }, (_, i) => {
  const st = subteams[i % subteams.length];
  const st2 = subteams[(i + 3) % subteams.length];
  const u = users[i % users.length];
  return {
    id: uuid(i, "ta"), project_id: uuid(0, "pr"), subteam_id: st.id,
    subsystem_id: null, parent_task_id: null,
    title: `Task ${i} — a fairly typical task title of moderate length`,
    description: null, type: "part", status: statuses[i % statuses.length],
    priority: ["low", "medium", "high", "critical"][i % 4],
    owner_id: u.id, start_date: null, due_date: "2026-09-15",
    estimate_days: 3, mrl: null, on_critical_path: false, created_by: null,
    subteam: st, subteams: [st, st2], subsystem: null, owner: u, owners: [u],
  };
});
const dependencies = Array.from({ length: Math.min(NDEPS, Math.max(N - 1, 0)) }, (_, i) => ({
  predecessor_id: tasks[i].id,
  successor_id: tasks[(i + 7) % tasks.length].id,
  dep_type: "FS", lag_days: 0,
}));

usePmStore.setState({
  hydrated: true, projectId: uuid(0, "pr"), activeProjectId: uuid(0, "pr"),
  tasks, subteams, users, subsystems: [], dependencies,
  selectedTaskIds: new Set(),
} as never);

const team = qs.get("team");
const View = VIEW === "table" ? TableViewClient : BoardViewClient;

// Mirrors PmModule's <main>: the animated blurred ScopeAura sits behind a
// relative z-10 wrapper holding the view.
function Shell() {
  return (
    <div className="pm-root flex h-full w-full overflow-hidden bg-helios-base text-helios-text">
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {WITH_AURA ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 0 }} aria-hidden>
            <div className="pm-aura pm-aura-tl" style={{ background: "radial-gradient(circle at center, rgba(140,29,64,0.2) 0%, transparent 62%)" }} />
            <div className="pm-aura pm-aura-br" style={{ background: "radial-gradient(circle at center, rgba(255,198,39,0.16) 0%, transparent 62%)" }} />
            <div className="pm-aura pm-aura-glow" style={{ background: "radial-gradient(circle at center, rgba(140,29,64,0.1) 0%, transparent 70%)" }} />
          </div>
        ) : null}
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <View teamSlug={team} />
        </div>
      </main>
    </div>
  );
}

performance.mark("mount-start");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PmRouterProvider initialPath={`/${VIEW}`}>
      <Shell />
    </PmRouterProvider>
  </StrictMode>,
);
// Interaction benches: how much work a single selection toggle / a single
// filter keystroke costs, measured to the next painted frame.
const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
async function bench(fn: () => void, reps: number) {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    await twoFrames();
    out.push(performance.now() - t);
  }
  out.sort((a, b) => a - b);
  return { median: out[Math.floor(out.length / 2)], max: out[out.length - 1] };
}
(window as never as Record<string, unknown>).__benchToggle = () =>
  bench(() => usePmStore.getState().toggleSelected(tasks[Math.floor(Math.random() * tasks.length)].id), 21);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    performance.mark("mount-end");
    performance.measure("mount", "mount-start", "mount-end");
    (window as never as Record<string, unknown>).__mountMs =
      performance.getEntriesByName("mount")[0].duration;
    document.title = "BOARD-READY";
  });
});
