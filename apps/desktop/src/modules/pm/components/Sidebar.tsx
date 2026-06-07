"use client";

import type { Subteam } from "@helios/pm-ui";
import {
  IconActivity,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronsLeft,
  IconChevronsRight,
  IconClipboardList,
  IconClockExclamation,
  IconColumns3,
  IconFileText,
  IconGraph,
  IconLayoutDashboard,
  IconListDetails,
  IconPencil,
  IconPlus,
  IconStack2,
  IconTimeline,
  IconTrash,
  IconTruck,
  type TablerIcon,
} from "@tabler/icons-react";
import { Link } from "@pm/lib/router";
import { usePathname, useRouter } from "@pm/lib/router";
import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ProjectDialog } from "@pm/components/ProjectDialog";
import { SubteamDialog } from "@pm/components/SubteamDialog";
import { usePmStore, selectIsAdmin } from "@pm/lib/pmStore";
import {
  BUILD_LABELS,
  BUILD_SEGMENTS,
  DEFAULT_VIEW_ORDER,
  WORKSPACES,
  WORKSPACE_LABELS,
  activeBuildSegment,
  activeTeamSlug,
  activeViewSegment,
  activeWorkspace,
  recallSidebarCollapsed,
  rememberScopeView,
  rememberSidebarCollapsed,
  rememberViewOrder,
  resolveViewOrder,
  viewHref,
  workspaceHomeHref,
  type BuildSegment,
  type ViewSegment,
} from "@pm/lib/nav";

type IconComponent = TablerIcon;

interface NavItem {
  view: ViewSegment;
  label: string;
  Icon: IconComponent;
}

const BUILD_ICON: Record<BuildSegment, IconComponent> = {
  desk: IconClipboardList,
  vendors: IconTruck,
  calendar: IconCalendar,
  gantt: IconTimeline,
};

const VIEW_LABEL: Record<ViewSegment, string> = {
  dashboard: "Dashboard",
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  gantt: "Gantt",
  graph: "Graph",
  pages: "Pages",
  activity: "Activity",
};

const VIEW_ICON: Record<ViewSegment, NavItem["Icon"]> = {
  dashboard: IconLayoutDashboard,
  table: IconListDetails,
  board: IconColumns3,
  calendar: IconCalendar,
  gantt: IconTimeline,
  graph: IconGraph,
  pages: IconFileText,
  activity: IconActivity,
};

// One draggable Views row. The whole row is the drag handle, but the 4px
// PointerSensor activation distance means a plain click still navigates rather
// than starting a drag. The PM Link isn't forwardRef-able, so the row is a
// native <a> wired to the in-memory router (mirroring what Link renders) — that
// gives dnd-kit a real DOM node for setNodeRef while preserving navigation.
export function SortableViewItem({
  view,
  href,
  active,
}: {
  view: ViewSegment;
  href: string;
  active: boolean;
}) {
  const router = useRouter();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: view });
  const Icon = VIEW_ICON[view];
  return (
    <a
      ref={setNodeRef}
      href={href}
      // CRITICAL: anchors are natively draggable, and dnd-kit's PointerSensor
      // only handles pointer events — so Chromium starts a *parallel* native
      // HTML5 link-drag. In the Tauri webview (dragDropEnabled:false) dropping
      // that link onto the window performs a full-document navigation to href,
      // re-bootstrapping the whole app back to the default "logs" module. Kill
      // the native drag entirely (belt-and-suspenders: attribute + onDragStart)
      // so only dnd-kit's pointer-driven sort can start. Click-to-nav and the
      // sortable reorder are unaffected.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        router.push(href);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      {...attributes}
      {...listeners}
      className={
        "flex cursor-grab touch-none select-none items-center gap-2 rounded px-2 py-1.5 text-sm font-normal transition-colors active:cursor-grabbing " +
        (active
          ? "bg-asu-gold/15 text-asu-gold"
          : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold") +
        (isDragging ? " opacity-60" : "")
      }
    >
      <Icon size={16} strokeWidth={1.5} />
      {VIEW_LABEL[view]}
    </a>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  // The Design workspace home href is derived from localStorage (last-used
  // view), which is unavailable during SSR. Gate it behind a mount flag so the
  // first client render matches the server markup and avoids a hydration
  // mismatch; it updates to the remembered view immediately after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Per-user Views ordering. Initialized to the canonical default so the first
  // (SSR/hydration) render is deterministic, then synced to the persisted order
  // on mount — same pattern as the `mounted` flag above.
  const [viewOrder, setViewOrder] = useState<ViewSegment[]>(() => [
    ...DEFAULT_VIEW_ORDER,
  ]);
  useEffect(() => setViewOrder(resolveViewOrder()), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleViewDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setViewOrder((prev) => {
      const from = prev.indexOf(active.id as ViewSegment);
      const to = prev.indexOf(over.id as ViewSegment);
      if (from === -1 || to === -1) return prev;
      const next = arrayMove(prev, from, to);
      rememberViewOrder(next);
      return next;
    });
  }
  const subteams = usePmStore((s) => s.subteams);
  const projects = usePmStore((s) => s.projects);
  const activeProjectId = usePmStore((s) => s.activeProjectId);
  const setActiveProject = usePmStore((s) => s.setActiveProject);
  const addProject = usePmStore((s) => s.addProject);
  const renameProject = usePmStore((s) => s.renameProject);
  const addSubteam = usePmStore((s) => s.addSubteam);
  const updateSubteam = usePmStore((s) => s.updateSubteam);
  const deleteSubteam = usePmStore((s) => s.deleteSubteam);
  const setReportOpen = usePmStore((s) => s.setReportOpen);
  // Deleting a subteam re-homes its sole-membership tasks server-side, which RLS
  // only permits for admins — gate the whole affordance behind the admin role.
  const isAdmin = usePmStore(selectIsAdmin);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const currentWorkspace = activeWorkspace(pathname);
  const currentBuildSegment = activeBuildSegment(pathname);
  const currentTeamSlug = activeTeamSlug(pathname);
  const currentView = activeViewSegment(pathname);
  const currentTeam = currentTeamSlug
    ? subteams.find((s) => s.slug === currentTeamSlug)
    : null;

  // --- Project switcher popover ---------------------------------------------
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    function onPointer(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSwitcherOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [switcherOpen]);

  // --- Dialog state ----------------------------------------------------------
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const renamingProject = renamingProjectId
    ? (projects.find((p) => p.id === renamingProjectId) ?? null)
    : null;

  const [subteamDialogOpen, setSubteamDialogOpen] = useState(false);
  const [editingSubteam, setEditingSubteam] = useState<Subteam | null>(null);

  function openNewProject() {
    setRenamingProjectId(null);
    setProjectDialogOpen(true);
    setSwitcherOpen(false);
  }

  function openRenameProject(id: string) {
    setRenamingProjectId(id);
    setProjectDialogOpen(true);
    setSwitcherOpen(false);
  }

  function openNewSubteam() {
    setEditingSubteam(null);
    setSubteamDialogOpen(true);
  }

  function openEditSubteam(s: Subteam) {
    setEditingSubteam(s);
    setSubteamDialogOpen(true);
  }

  function handleDeleteSubteam(s: Subteam) {
    // Tasks whose ONLY membership is this subteam must land somewhere — the admin
    // chooses a fallback team and those tasks are reassigned (never deleted).
    const others = subteams.filter((x) => x.id !== s.id);
    if (others.length === 0) {
      window.alert(
        `Can't remove ${s.name}: it's the only subteam, so there's nowhere to reassign its tasks.`,
      );
      return;
    }

    const menu = others.map((x, i) => `${i + 1}. ${x.name}`).join("\n");
    const answer = window.prompt(
      `Remove ${s.name}?\n\n` +
        `Any task that belongs ONLY to this subteam will be reassigned to a ` +
        `fallback team (no tasks are deleted). Pick the fallback team by number:\n\n` +
        menu,
      "1",
    );
    if (answer === null) return; // cancelled
    const idx = Number.parseInt(answer.trim(), 10) - 1;
    const fallback = others[idx];
    if (!fallback) {
      window.alert("That wasn't a valid choice — nothing was removed.");
      return;
    }
    if (
      window.confirm(
        `Remove ${s.name} and reassign its sole-membership tasks to ${fallback.name}?`,
      )
    ) {
      deleteSubteam(s.id, fallback.id);
    }
  }

  // Switching scope (project ↔ subteam) keeps the current view. We still
  // remember the project-scope view so returning to the Design workspace from
  // Build/Compete reopens the last-used view (workspaceHomeHref).
  useEffect(() => {
    if (currentView) rememberScopeView(null, currentView);
  }, [currentView]);

  // The view a scope link should open: carry whatever view is active now.
  const carryView: ViewSegment = currentView ?? "table";

  // Collapsed sidebar (reclaim horizontal space). Persisted per user.
  const [collapsed, setCollapsed] = useState(() => recallSidebarCollapsed());
  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      rememberSidebarCollapsed(next);
      return next;
    });
  }

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-helios-line bg-helios-panel py-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="rounded p-1.5 text-helios-dim transition-colors hover:bg-helios-base hover:text-helios-text"
        >
          <IconChevronsRight size={18} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-helios-line bg-helios-panel">
      <div className="flex justify-end border-b border-helios-line px-2 py-1">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="rounded p-1 text-helios-dim transition-colors hover:bg-helios-base hover:text-helios-text"
        >
          <IconChevronsLeft size={16} strokeWidth={1.5} />
        </button>
      </div>
      {/* Project switcher */}
      <div ref={switcherRef} className="relative border-b border-helios-line">
        <button
          type="button"
          onClick={() => setSwitcherOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 px-4 py-4 text-left transition-colors hover:bg-helios-base/30"
        >
          <span className="min-w-0">
            <span className="block text-xs font-medium uppercase tracking-widest text-helios-dim">
              Project
            </span>
            <span className="mt-1 block truncate text-base font-medium text-helios-text">
              {activeProject?.name ?? "—"}
            </span>
            {activeProject?.description ? (
              <span className="block truncate text-xs text-helios-dim">
                {activeProject.description}
              </span>
            ) : null}
          </span>
          <IconChevronDown
            size={16}
            strokeWidth={1.5}
            className={
              "shrink-0 text-helios-dim transition-transform " +
              (switcherOpen ? "rotate-180" : "")
            }
          />
        </button>

        {switcherOpen ? (
          <div className="absolute inset-x-2 top-full z-20 mt-1 overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-lg">
            <ul className="max-h-64 overflow-y-auto py-1">
              {projects.map((p) => {
                const active = p.id === activeProjectId;
                return (
                  <li key={p.id} className="group flex items-center px-1">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProject(p.id);
                        setSwitcherOpen(false);
                      }}
                      className={
                        "flex flex-1 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors " +
                        (active
                          ? "text-helios-text"
                          : "text-helios-dim hover:bg-helios-base hover:text-asu-gold")
                      }
                    >
                      <span className="truncate">{p.name}</span>
                      {active ? (
                        <IconCheck size={14} strokeWidth={1.5} className="shrink-0 text-asu-gold" />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => openRenameProject(p.id)}
                      aria-label={`Rename ${p.name}`}
                      className="rounded p-1 text-helios-dim opacity-0 transition-opacity hover:bg-helios-base hover:text-asu-gold group-hover:opacity-100"
                    >
                      <IconPencil size={14} strokeWidth={1.5} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-helios-line p-1">
              <button
                type="button"
                onClick={openNewProject}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-normal text-helios-text hover:bg-helios-base"
              >
                <IconPlus size={14} strokeWidth={1.5} />
                New project
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Workspace switcher */}
      <div className="border-b border-helios-line p-2">
        <div className="flex gap-0.5 rounded-md bg-helios-base p-0.5">
          {WORKSPACES.map((ws) => {
            const active = currentWorkspace === ws;
            const href =
              ws === "design" && !mounted ? "/table" : workspaceHomeHref(ws);
            return (
              <Link
                key={ws}
                href={href}
                className={
                  "flex-1 rounded px-2 py-1 text-center text-xs font-medium transition-colors " +
                  (active
                    ? "bg-asu-gold text-helios-base"
                    : "text-helios-dim hover:bg-helios-panel hover:text-asu-gold")
                }
              >
                {WORKSPACE_LABELS[ws]}
              </Link>
            );
          })}
        </div>
      </div>

      {currentWorkspace === "design" && (
        <>
          {/* Contextual scope label */}
          <div className="border-b border-helios-line px-4 py-2.5 text-xs font-medium uppercase tracking-widest text-helios-dim">
            Viewing{" "}
            {currentTeam ? (
              <span style={{ color: currentTeam.color ?? "#D8DCE2" }}>
                {currentTeam.name}
              </span>
            ) : (
              <span className="text-helios-text">Project</span>
            )}
          </div>

          <div className="px-2 pt-3">
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-normal text-helios-dim transition-colors hover:bg-helios-base/60 hover:text-asu-gold"
            >
              <IconClockExclamation size={16} strokeWidth={1.5} />
              Deadlines report
            </button>
          </div>

          <nav className="flex flex-col gap-0.5 px-2 py-3">
            <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-widest text-helios-dim">
              Views
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleViewDragEnd}
            >
              <SortableContext items={viewOrder} strategy={verticalListSortingStrategy}>
                {viewOrder.map((view) => (
                  <SortableViewItem
                    key={view}
                    view={view}
                    href={viewHref(view, currentTeamSlug)}
                    active={currentView === view}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </nav>

          <div className="mt-2 border-t border-helios-line px-2 py-3">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <p className="text-xs font-medium uppercase tracking-widest text-helios-dim">
                Subteams
              </p>
              <button
                type="button"
                onClick={openNewSubteam}
                aria-label="Add subteam"
                className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-asu-gold"
              >
                <IconPlus size={14} strokeWidth={1.5} />
              </button>
            </div>
            <ul className="flex flex-col gap-0.5">
              <li className="flex items-center">
                <Link
                  href={viewHref(carryView, null)}
                  className={
                    "flex flex-1 items-center gap-2 rounded px-2 py-1 text-sm font-normal transition-colors " +
                    (!currentTeamSlug
                      ? "bg-asu-gold/15 text-asu-gold"
                      : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
                  }
                >
                  <IconStack2 size={14} strokeWidth={1.5} className="shrink-0" />
                  <span className="truncate">All subteams</span>
                </Link>
              </li>
              {subteams.map((s) => {
                const active = currentTeamSlug === s.slug;
                return (
                  <li key={s.id} className="group flex items-center">
                    <Link
                      href={viewHref(carryView, s.slug)}
                      className={
                        "flex flex-1 items-center gap-2 rounded px-2 py-1 text-sm font-normal transition-colors " +
                        (active
                          ? "bg-asu-gold/15 text-asu-gold"
                          : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
                      }
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: s.color ?? "#6B7280" }}
                      />
                      <span className="truncate">{s.name}</span>
                    </Link>
                    <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => openEditSubteam(s)}
                        aria-label={`Edit ${s.name}`}
                        className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-asu-gold"
                      >
                        <IconPencil size={13} strokeWidth={1.5} />
                      </button>
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => handleDeleteSubteam(s)}
                          aria-label={`Remove ${s.name}`}
                          className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-red-400"
                        >
                          <IconTrash size={13} strokeWidth={1.5} />
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {currentWorkspace === "build" && (
        <nav className="flex flex-col gap-0.5 px-2 py-3">
          <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-widest text-helios-dim">
            Build
          </p>
          {BUILD_SEGMENTS.map((seg) => {
            const Icon = BUILD_ICON[seg];
            const active = currentBuildSegment === seg;
            return (
              <Link
                key={seg}
                href={`/build/${seg}`}
                className={
                  "flex items-center gap-2 rounded px-2 py-1.5 text-sm font-normal transition-colors " +
                  (active
                    ? "bg-asu-gold/15 text-asu-gold"
                    : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
                }
              >
                <Icon size={16} strokeWidth={1.5} />
                {BUILD_LABELS[seg]}
              </Link>
            );
          })}
        </nav>
      )}

      {currentWorkspace === "compete" && (
        <div className="px-4 py-3 text-xs text-helios-dim">
          Competition planning is coming soon.
        </div>
      )}

      <div className="mt-auto border-t border-helios-line px-4 py-3 text-[10px] text-helios-dim">
        Helios PM · phase 1 work in progress
      </div>

      <ProjectDialog
        open={projectDialogOpen}
        onClose={() => setProjectDialogOpen(false)}
        project={renamingProject}
        onSave={(values) => {
          if (renamingProject) {
            renameProject(renamingProject.id, values);
          } else {
            addProject(values.name, values.description ?? undefined);
          }
        }}
      />

      <SubteamDialog
        open={subteamDialogOpen}
        onClose={() => setSubteamDialogOpen(false)}
        subteam={editingSubteam}
        onSave={(subteam) => {
          if (editingSubteam) {
            updateSubteam(editingSubteam.id, subteam);
          } else {
            addSubteam(subteam);
          }
        }}
      />
    </aside>
  );
}
