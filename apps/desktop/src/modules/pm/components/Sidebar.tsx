"use client";

import type { Subteam } from "@helios/pm-ui";
import {
  IconActivity,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconClipboardList,
  IconColumns3,
  IconFileText,
  IconGraph,
  IconListDetails,
  IconPencil,
  IconPlus,
  IconStack2,
  IconTimeline,
  IconTrash,
  IconTruck,
} from "@tabler/icons-react";
import { Link } from "@pm/lib/router";
import { usePathname } from "@pm/lib/router";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { ProjectDialog } from "@pm/components/ProjectDialog";
import { SubteamDialog } from "@pm/components/SubteamDialog";
import { usePmStore } from "@pm/lib/pmStore";
import {
  BUILD_LABELS,
  BUILD_SEGMENTS,
  VIEW_SEGMENTS,
  WORKSPACES,
  WORKSPACE_LABELS,
  activeBuildSegment,
  activeTeamSlug,
  activeViewSegment,
  activeWorkspace,
  rememberScopeView,
  viewHref,
  workspaceHomeHref,
  type BuildSegment,
  type ViewSegment,
} from "@pm/lib/nav";

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number }>;

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
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  gantt: "Gantt",
  graph: "Graph",
  pages: "Pages",
  activity: "Activity",
};

const VIEW_ICON: Record<ViewSegment, NavItem["Icon"]> = {
  table: IconListDetails,
  board: IconColumns3,
  calendar: IconCalendar,
  gantt: IconTimeline,
  graph: IconGraph,
  pages: IconFileText,
  activity: IconActivity,
};

export function Sidebar() {
  const pathname = usePathname();
  // The Design workspace home href is derived from localStorage (last-used
  // view), which is unavailable during SSR. Gate it behind a mount flag so the
  // first client render matches the server markup and avoids a hydration
  // mismatch; it updates to the remembered view immediately after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const subteams = usePmStore((s) => s.subteams);
  const projects = usePmStore((s) => s.projects);
  const activeProjectId = usePmStore((s) => s.activeProjectId);
  const setActiveProject = usePmStore((s) => s.setActiveProject);
  const addProject = usePmStore((s) => s.addProject);
  const renameProject = usePmStore((s) => s.renameProject);
  const addSubteam = usePmStore((s) => s.addSubteam);
  const updateSubteam = usePmStore((s) => s.updateSubteam);
  const deleteSubteam = usePmStore((s) => s.deleteSubteam);

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
    if (
      window.confirm(
        `Remove ${s.name}? Tasks and subsystems in this subteam will be deleted.`,
      )
    ) {
      deleteSubteam(s.id);
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

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-helios-line bg-helios-panel">
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

          <nav className="flex flex-col gap-0.5 px-2 py-3">
            <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-widest text-helios-dim">
              Views
            </p>
            {VIEW_SEGMENTS.map((view) => {
              const Icon = VIEW_ICON[view];
              const active = currentView === view;
              return (
                <Link
                  key={view}
                  href={viewHref(view, currentTeamSlug)}
                  className={
                    "flex items-center gap-2 rounded px-2 py-1.5 text-sm font-normal transition-colors " +
                    (active
                      ? "bg-asu-gold/15 text-asu-gold"
                      : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
                  }
                >
                  <Icon size={16} strokeWidth={1.5} />
                  {VIEW_LABEL[view]}
                </Link>
              );
            })}
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
                      <button
                        type="button"
                        onClick={() => handleDeleteSubteam(s)}
                        aria-label={`Remove ${s.name}`}
                        className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-red-400"
                      >
                        <IconTrash size={13} strokeWidth={1.5} />
                      </button>
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
