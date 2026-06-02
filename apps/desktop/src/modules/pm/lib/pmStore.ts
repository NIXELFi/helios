import type {
  Activity,
  Block,
  BuildRecord,
  CalendarEvent,
  DrawingReview,
  Milestone,
  Page,
  Project,
  Subsystem,
  Subteam,
  TaskComment,
  TaskDependency,
  TaskRow,
  User,
  Vendor,
} from "@helios/pm-ui";
import { create } from "zustand";

// Per-project snapshot of the working arrays. The store keeps one of these
// projected into its flat top-level fields (the active project) so every
// existing view/selector keeps reading the flat fields unchanged.
export interface ProjectData {
  tasks: TaskRow[];
  subteams: Subteam[];
  subsystems: Subsystem[];
  users: User[];
  dependencies: TaskDependency[];
  milestones: Milestone[];
  pages: Page[];
  blocks: Block[];
  activity: Activity[];
  vendors: Vendor[];
  comments: TaskComment[];
  buildRecords: BuildRecord[];
  events: CalendarEvent[];
}

export interface BaselineOrg {
  subteams: ReadonlyArray<Subteam>;
  subsystems: ReadonlyArray<Subsystem>;
  users: ReadonlyArray<User>;
}

interface HydrateInput {
  projects: ReadonlyArray<Project>;
  projectData: Record<string, ProjectData>;
  activeProjectId: string;
  currentUserId: string;
  baselineOrg: BaselineOrg;
}

// Snapshot the active flat fields back into a ProjectData record.
function snapshotFlat(s: PmState): ProjectData {
  return {
    tasks: s.tasks,
    subteams: s.subteams,
    subsystems: s.subsystems,
    users: s.users,
    dependencies: s.dependencies,
    milestones: s.milestones,
    pages: s.pages,
    blocks: s.blocks,
    activity: s.activity,
    vendors: s.vendors,
    comments: s.comments,
    buildRecords: s.buildRecords,
    events: s.events,
  };
}

// Load a ProjectData record into the flat fields (fresh array instances so
// later mutations never alias another project's stored arrays).
function loadFlat(d: ProjectData) {
  return {
    tasks: [...d.tasks],
    subteams: [...d.subteams],
    subsystems: [...d.subsystems],
    users: [...d.users],
    dependencies: [...d.dependencies],
    milestones: [...d.milestones],
    pages: [...d.pages],
    blocks: [...d.blocks],
    activity: [...d.activity],
    vendors: [...d.vendors],
    comments: [...d.comments],
    buildRecords: [...d.buildRecords],
    events: [...d.events],
  };
}

// A brand-new project keeps the org structure (subteams/subsystems/users) but
// starts with no tasks, pages, vendors, etc.
function emptyProjectData(org: BaselineOrg): ProjectData {
  return {
    tasks: [],
    subteams: org.subteams.map((x) => ({ ...x })),
    subsystems: org.subsystems.map((x) => ({ ...x })),
    users: org.users.map((x) => ({ ...x })),
    dependencies: [],
    milestones: [],
    pages: [],
    blocks: [],
    activity: [],
    vendors: [],
    comments: [],
    buildRecords: [],
    events: [],
  };
}

// --- Browser persistence ----------------------------------------------------
// Only the projects list (names + created), the active project id, and renames
// persist. Per-project data edits intentionally do not (seed re-hydrates).

const ACTIVE_PROJECT_KEY = "helios:activeProject";
const PROJECTS_KEY = "helios:projects";

function persistActiveProject(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

function persistProjects(projects: Project[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // ignore
  }
}

export function readPersistedActiveProject(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function readPersistedProjects(): Project[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROJECTS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ok = parsed.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof (p as Project).id === "string" &&
        typeof (p as Project).name === "string",
    );
    if (!ok) return null;
    return parsed.map((p) => ({
      id: (p as Project).id,
      name: (p as Project).name,
      description: (p as Project).description ?? null,
    }));
  } catch {
    return null;
  }
}

interface PmState {
  hydrated: boolean;
  projectId: string;
  currentUserId: string;

  // Multi-project support. The flat fields below mirror the active project.
  projects: Project[];
  activeProjectId: string;
  projectData: Record<string, ProjectData>;
  baselineOrg: BaselineOrg;

  tasks: TaskRow[];
  subteams: Subteam[];
  subsystems: Subsystem[];
  users: User[];
  dependencies: TaskDependency[];
  milestones: Milestone[];
  pages: Page[];
  blocks: Block[];
  activity: Activity[];
  vendors: Vendor[];
  comments: TaskComment[];
  buildRecords: BuildRecord[];
  events: CalendarEvent[];

  // UI state: the task whose detail sheet is open, or null
  selectedTaskId: string | null;
  selectTask: (id: string | null) => void;

  // Per-view memory of the most recently viewed milestone for the details popover
  selectedMilestoneId: string | null;
  selectMilestone: (id: string | null) => void;

  // Calendar countdown dim toggles — milestone IDs that the user has dimmed
  dimmedMilestoneIds: Set<string>;
  toggleMilestoneDim: (id: string) => void;

  hydrate: (input: HydrateInput) => void;

  // Project actions
  setActiveProject: (id: string) => void;
  addProject: (name: string, description?: string) => void;
  renameProject: (id: string, patch: { name?: string; description?: string | null }) => void;
  // Reconcile browser-persisted project list + active id over the seed.
  reconcilePersisted: (persisted: {
    projects?: Project[];
    activeProjectId?: string;
  }) => void;

  // Subteam mutations
  addSubteam: (subteam: Subteam) => void;
  updateSubteam: (id: string, patch: Partial<Subteam>) => void;
  deleteSubteam: (id: string) => void;

  // Task mutations
  addTask: (task: TaskRow) => void;
  updateTask: (id: string, patch: Partial<TaskRow>) => void;
  deleteTask: (id: string) => void;

  // Dependency mutations
  addDependency: (dep: TaskDependency) => void;
  removeDependency: (predecessorId: string, successorId: string) => void;

  // Block mutations
  updateBlock: (id: string, patch: Partial<Block>) => void;

  // Milestone mutations
  addMilestone: (m: Milestone) => void;
  updateMilestone: (id: string, patch: Partial<Milestone>) => void;
  deleteMilestone: (id: string) => void;

  // Vendor mutations (Build workspace)
  addVendor: (v: Vendor) => void;
  updateVendor: (id: string, patch: Partial<Vendor>) => void;
  deleteVendor: (id: string) => void;

  // Comment mutations
  addComment: (c: TaskComment) => void;
  deleteComment: (id: string) => void;

  // Calendar event mutations
  addEvent: (e: CalendarEvent) => void;
  updateEvent: (id: string, patch: Partial<CalendarEvent>) => void;
  deleteEvent: (id: string) => void;

  // Build record mutations (part file / drawing / review)
  updateBuildRecord: (taskId: string, patch: Partial<BuildRecord>) => void;
  reviewDrawing: (taskId: string, review: DrawingReview) => void;
}

function logActivity(
  state: PmState,
  partial: Omit<Activity, "id" | "created_at" | "project_id" | "actor_id">,
): Activity[] {
  const entry: Activity = {
    id: crypto.randomUUID(),
    project_id: state.projectId,
    actor_id: state.currentUserId || null,
    created_at: new Date().toISOString(),
    ...partial,
  };
  return [entry, ...state.activity].slice(0, 250);
}

function subteamsForTask(task: TaskRow | undefined): string[] {
  return task ? [task.subteam_id] : [];
}

export const usePmStore = create<PmState>((set) => ({
  hydrated: false,
  projectId: "",
  currentUserId: "",
  projects: [],
  activeProjectId: "",
  projectData: {},
  baselineOrg: { subteams: [], subsystems: [], users: [] },
  tasks: [],
  subteams: [],
  subsystems: [],
  users: [],
  dependencies: [],
  milestones: [],
  pages: [],
  blocks: [],
  activity: [],
  vendors: [],
  comments: [],
  buildRecords: [],
  events: [],

  selectedTaskId: null,
  selectTask: (id) => set({ selectedTaskId: id }),

  selectedMilestoneId: null,
  selectMilestone: (id) => set({ selectedMilestoneId: id }),

  dimmedMilestoneIds: new Set<string>(),
  toggleMilestoneDim: (id) =>
    set((s) => {
      const next = new Set(s.dimmedMilestoneIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { dimmedMilestoneIds: next };
    }),

  hydrate: (input) =>
    set(() => {
      const active =
        input.projectData[input.activeProjectId] ??
        emptyProjectData(input.baselineOrg);
      return {
        hydrated: true,
        projectId: input.activeProjectId,
        activeProjectId: input.activeProjectId,
        currentUserId: input.currentUserId,
        projects: input.projects.map((p) => ({ ...p })),
        projectData: input.projectData,
        baselineOrg: {
          subteams: [...input.baselineOrg.subteams],
          subsystems: [...input.baselineOrg.subsystems],
          users: [...input.baselineOrg.users],
        },
        ...loadFlat(active),
      };
    }),

  setActiveProject: (id) =>
    set((s) => {
      if (id === s.activeProjectId) return {};
      const target = s.projectData[id];
      if (!target) return {};
      const projectData = { ...s.projectData, [s.activeProjectId]: snapshotFlat(s) };
      persistActiveProject(id);
      return {
        projectData,
        activeProjectId: id,
        projectId: id,
        selectedTaskId: null,
        selectedMilestoneId: null,
        ...loadFlat(target),
      };
    }),

  addProject: (name, description) =>
    set((s) => {
      const id = crypto.randomUUID();
      const project: Project = {
        id,
        name: name.trim() || "Untitled project",
        description: description?.trim() || null,
      };
      const data = emptyProjectData(s.baselineOrg);
      const projects = [...s.projects, project];
      const projectData = {
        ...s.projectData,
        [s.activeProjectId]: snapshotFlat(s),
        [id]: data,
      };
      persistProjects(projects);
      persistActiveProject(id);
      return {
        projects,
        projectData,
        activeProjectId: id,
        projectId: id,
        selectedTaskId: null,
        selectedMilestoneId: null,
        ...loadFlat(data),
      };
    }),

  renameProject: (id, patch) =>
    set((s) => {
      const projects = s.projects.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      );
      persistProjects(projects);
      return { projects };
    }),

  reconcilePersisted: (persisted) =>
    set((s) => {
      let projects = s.projects;
      let projectData = s.projectData;

      if (persisted.projects && persisted.projects.length > 0) {
        const nextData: Record<string, ProjectData> = { ...s.projectData };
        const merged: Project[] = [];
        const seen = new Set<string>();
        for (const p of persisted.projects) {
          merged.push({ id: p.id, name: p.name, description: p.description ?? null });
          seen.add(p.id);
          if (!nextData[p.id]) {
            // User-created project (its data is not persisted) → recreate empty.
            nextData[p.id] = emptyProjectData(s.baselineOrg);
          }
        }
        // Keep any seed projects missing from the persisted list.
        for (const p of s.projects) {
          if (!seen.has(p.id)) merged.push(p);
        }
        projects = merged;
        projectData = nextData;
      }

      const targetId = persisted.activeProjectId;
      const target = targetId ? projectData[targetId] : undefined;
      if (targetId && target && targetId !== s.activeProjectId) {
        const snapshot = { ...projectData, [s.activeProjectId]: snapshotFlat(s) };
        return {
          projects,
          projectData: snapshot,
          activeProjectId: targetId,
          projectId: targetId,
          selectedTaskId: null,
          selectedMilestoneId: null,
          ...loadFlat(target),
        };
      }

      return { projects, projectData };
    }),

  addSubteam: (subteam) =>
    set((s) => ({
      subteams: [...s.subteams, subteam],
      activity: logActivity(s, {
        action: "created",
        target_type: "subteam",
        target_id: subteam.id,
        target_name: subteam.name,
        subteam_ids: [subteam.id],
        payload: { code: subteam.code },
      }),
    })),

  updateSubteam: (id, patch) =>
    set((s) => {
      const current = s.subteams.find((x) => x.id === id);
      if (!current) return {};
      const next: Subteam = { ...current, ...patch };
      return {
        subteams: s.subteams.map((x) => (x.id === id ? next : x)),
        // Tasks embed a copy of their subteam — re-embed the updated record.
        tasks: s.tasks.map((t) =>
          t.subteam_id === id ? { ...t, subteam: next } : t,
        ),
        activity: logActivity(s, {
          action: "updated",
          target_type: "subteam",
          target_id: id,
          target_name: next.name,
          subteam_ids: [id],
          payload: patch,
        }),
      };
    }),

  deleteSubteam: (id) =>
    set((s) => {
      const removed = s.subteams.find((x) => x.id === id);
      if (!removed) return {};
      const removedTaskIds = new Set(
        s.tasks.filter((t) => t.subteam_id === id).map((t) => t.id),
      );
      return {
        subteams: s.subteams.filter((x) => x.id !== id),
        subsystems: s.subsystems.filter((x) => x.subteam_id !== id),
        tasks: s.tasks.filter((t) => t.subteam_id !== id),
        dependencies: s.dependencies.filter(
          (d) =>
            !removedTaskIds.has(d.predecessor_id) &&
            !removedTaskIds.has(d.successor_id),
        ),
        pages: s.pages.map((p) =>
          p.subteam_id === id ? { ...p, subteam_id: null } : p,
        ),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "subteam",
          target_id: id,
          target_name: removed.name,
          subteam_ids: [id],
          payload: null,
        }),
      };
    }),

  addTask: (task) =>
    set((s) => ({
      tasks: [task, ...s.tasks],
      activity: logActivity(s, {
        action: "created",
        target_type: "task",
        target_id: task.id,
        target_name: task.title,
        subteam_ids: subteamsForTask(task),
        payload: { type: task.type },
      }),
    })),

  updateTask: (id, patch) =>
    set((s) => {
      const current = s.tasks.find((t) => t.id === id);
      if (!current) return {};
      const next: TaskRow = { ...current, ...patch };

      if (patch.subteam_id !== undefined) {
        const st = s.subteams.find((x) => x.id === patch.subteam_id);
        if (st) next.subteam = st;
      }
      if (patch.subsystem_id !== undefined) {
        next.subsystem = s.subsystems.find((x) => x.id === patch.subsystem_id) ?? null;
      }
      if (patch.owner_id !== undefined) {
        next.owner = s.users.find((x) => x.id === patch.owner_id) ?? null;
      }

      const tasks = s.tasks.map((t) => (t.id === id ? next : t));

      const statusChanged =
        patch.status !== undefined && patch.status !== current.status;

      const activity = statusChanged
        ? logActivity(s, {
            action: "status_changed",
            target_type: "task",
            target_id: id,
            target_name: next.title,
            subteam_ids: subteamsForTask(next),
            payload: { from: current.status, to: next.status },
          })
        : logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: id,
            target_name: next.title,
            subteam_ids: subteamsForTask(next),
            payload: patch,
          });

      return { tasks, activity };
    }),

  deleteTask: (id) =>
    set((s) => {
      const removed = s.tasks.find((t) => t.id === id);
      if (!removed) return {};
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        dependencies: s.dependencies.filter(
          (d) => d.predecessor_id !== id && d.successor_id !== id,
        ),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "task",
          target_id: id,
          target_name: removed.title,
          subteam_ids: subteamsForTask(removed),
          payload: null,
        }),
      };
    }),

  addDependency: (dep) =>
    set((s) => {
      if (dep.predecessor_id === dep.successor_id) return {};
      const exists = s.dependencies.some(
        (d) =>
          d.predecessor_id === dep.predecessor_id &&
          d.successor_id === dep.successor_id,
      );
      if (exists) return {};
      const reverseExists = s.dependencies.some(
        (d) =>
          d.predecessor_id === dep.successor_id &&
          d.successor_id === dep.predecessor_id,
      );
      if (reverseExists) return {};

      const pred = s.tasks.find((t) => t.id === dep.predecessor_id);
      const succ = s.tasks.find((t) => t.id === dep.successor_id);
      const teams = new Set<string>();
      if (pred) teams.add(pred.subteam_id);
      if (succ) teams.add(succ.subteam_id);

      return {
        dependencies: [...s.dependencies, dep],
        activity: logActivity(s, {
          action: "linked",
          target_type: "task_dependency",
          target_id: dep.successor_id,
          target_name: succ ? succ.title : null,
          subteam_ids: [...teams],
          payload: { predecessor: pred?.title ?? null },
        }),
      };
    }),

  removeDependency: (predecessorId, successorId) =>
    set((s) => {
      const exists = s.dependencies.some(
        (d) =>
          d.predecessor_id === predecessorId && d.successor_id === successorId,
      );
      if (!exists) return {};
      const pred = s.tasks.find((t) => t.id === predecessorId);
      const succ = s.tasks.find((t) => t.id === successorId);
      const teams = new Set<string>();
      if (pred) teams.add(pred.subteam_id);
      if (succ) teams.add(succ.subteam_id);
      return {
        dependencies: s.dependencies.filter(
          (d) =>
            !(d.predecessor_id === predecessorId && d.successor_id === successorId),
        ),
        activity: logActivity(s, {
          action: "unlinked",
          target_type: "task_dependency",
          target_id: successorId,
          target_name: succ ? succ.title : null,
          subteam_ids: [...teams],
          payload: { predecessor: pred?.title ?? null },
        }),
      };
    }),

  updateBlock: (id, patch) =>
    set((s) => ({
      blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    })),

  addMilestone: (m) =>
    set((s) => ({
      milestones: [...s.milestones, m].sort((a, b) =>
        a.target_date.localeCompare(b.target_date),
      ),
      activity: logActivity(s, {
        action: "created",
        target_type: "milestone",
        target_id: m.id,
        target_name: m.name,
        subteam_ids: [],
        payload: { date: m.target_date, type: m.type },
      }),
    })),

  updateMilestone: (id, patch) =>
    set((s) => {
      const current = s.milestones.find((x) => x.id === id);
      if (!current) return {};
      const next = { ...current, ...patch };
      return {
        milestones: s.milestones.map((m) => (m.id === id ? next : m)),
        activity: logActivity(s, {
          action: "updated",
          target_type: "milestone",
          target_id: id,
          target_name: next.name,
          subteam_ids: [],
          payload: patch,
        }),
      };
    }),

  deleteMilestone: (id) =>
    set((s) => {
      const removed = s.milestones.find((x) => x.id === id);
      if (!removed) return {};
      return {
        milestones: s.milestones.filter((m) => m.id !== id),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "milestone",
          target_id: id,
          target_name: removed.name,
          subteam_ids: [],
          payload: null,
        }),
      };
    }),

  addVendor: (v) =>
    set((s) => ({
      vendors: [...s.vendors, v].sort((a, b) => a.name.localeCompare(b.name)),
      activity: logActivity(s, {
        action: "created",
        target_type: "vendor",
        target_id: v.id,
        target_name: v.name,
        subteam_ids: [],
        payload: { category: v.category },
      }),
    })),

  updateVendor: (id, patch) =>
    set((s) => {
      const current = s.vendors.find((x) => x.id === id);
      if (!current) return {};
      const next = { ...current, ...patch };
      return {
        vendors: s.vendors
          .map((v) => (v.id === id ? next : v))
          .sort((a, b) => a.name.localeCompare(b.name)),
        activity: logActivity(s, {
          action: "updated",
          target_type: "vendor",
          target_id: id,
          target_name: next.name,
          subteam_ids: [],
          payload: patch,
        }),
      };
    }),

  deleteVendor: (id) =>
    set((s) => {
      const removed = s.vendors.find((x) => x.id === id);
      if (!removed) return {};
      return {
        vendors: s.vendors.filter((v) => v.id !== id),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "vendor",
          target_id: id,
          target_name: removed.name,
          subteam_ids: [],
          payload: null,
        }),
      };
    }),

  addComment: (c) =>
    set((s) => ({ comments: [c, ...s.comments] })),

  deleteComment: (id) =>
    set((s) => ({ comments: s.comments.filter((c) => c.id !== id) })),

  addEvent: (e) =>
    set((s) => ({
      events: [...s.events, e].sort((a, b) => a.date.localeCompare(b.date)),
    })),

  updateEvent: (id, patch) =>
    set((s) => ({
      events: s.events
        .map((e) => (e.id === id ? { ...e, ...patch } : e))
        .sort((a, b) => a.date.localeCompare(b.date)),
    })),

  deleteEvent: (id) =>
    set((s) => ({ events: s.events.filter((e) => e.id !== id) })),

  updateBuildRecord: (taskId, patch) =>
    set((s) => {
      const exists = s.buildRecords.some((b) => b.task_id === taskId);
      const buildRecords = exists
        ? s.buildRecords.map((b) => (b.task_id === taskId ? { ...b, ...patch } : b))
        : [
            ...s.buildRecords,
            {
              task_id: taskId,
              part_file: null,
              drawing_file: null,
              drawing_review: "not_submitted" as DrawingReview,
              ...patch,
            },
          ];
      return { buildRecords };
    }),

  reviewDrawing: (taskId, review) =>
    set((s) => {
      const task = s.tasks.find((t) => t.id === taskId);
      const exists = s.buildRecords.some((b) => b.task_id === taskId);
      const buildRecords = exists
        ? s.buildRecords.map((b) =>
            b.task_id === taskId ? { ...b, drawing_review: review } : b,
          )
        : [
            ...s.buildRecords,
            {
              task_id: taskId,
              part_file: null,
              drawing_file: null,
              drawing_review: review,
            },
          ];
      return {
        buildRecords,
        activity: logActivity(s, {
          action: "reviewed",
          target_type: "task",
          target_id: taskId,
          target_name: task ? task.title : null,
          subteam_ids: subteamsForTask(task),
          payload: { drawing_review: review },
        }),
      };
    }),
}));

// ---------------------------------------------------------------------------
// Helpers used by the per-subteam view scope rule:
//   "show all tasks in this subteam, plus any external tasks that participate
//    in a dependency with a task in this subteam — marked as either prerequisite
//    of, or dependent on, the subteam's work."
// ---------------------------------------------------------------------------

export type CrossTeamRelation = "owned" | "prerequisite_of_team" | "dependent_on_team";

export interface ScopedTask {
  task: TaskRow;
  relation: CrossTeamRelation;
  // The subteam's task(s) that this external task connects to, when relation
  // is prerequisite_of_team or dependent_on_team. Empty for "owned".
  bridgeTaskIds: string[];
}

export function scopeTasksToSubteam(
  tasks: ReadonlyArray<TaskRow>,
  dependencies: ReadonlyArray<TaskDependency>,
  subteamId: string,
): ScopedTask[] {
  const ownedIds = new Set(tasks.filter((t) => t.subteam_id === subteamId).map((t) => t.id));

  const out = new Map<string, ScopedTask>();
  // Own tasks first
  for (const t of tasks) {
    if (t.subteam_id === subteamId) {
      out.set(t.id, { task: t, relation: "owned", bridgeTaskIds: [] });
    }
  }
  // External tasks tied via dependencies
  for (const d of dependencies) {
    const predOwned = ownedIds.has(d.predecessor_id);
    const succOwned = ownedIds.has(d.successor_id);

    if (predOwned && !succOwned) {
      // Successor is external, depends on us → external is "dependent on team"
      const extTask = tasks.find((t) => t.id === d.successor_id);
      if (extTask) {
        const existing = out.get(extTask.id);
        if (existing) {
          if (!existing.bridgeTaskIds.includes(d.predecessor_id))
            existing.bridgeTaskIds.push(d.predecessor_id);
        } else {
          out.set(extTask.id, {
            task: extTask,
            relation: "dependent_on_team",
            bridgeTaskIds: [d.predecessor_id],
          });
        }
      }
    } else if (succOwned && !predOwned) {
      // Predecessor is external, we depend on it → external is "prerequisite of team"
      const extTask = tasks.find((t) => t.id === d.predecessor_id);
      if (extTask) {
        const existing = out.get(extTask.id);
        if (existing) {
          if (!existing.bridgeTaskIds.includes(d.successor_id))
            existing.bridgeTaskIds.push(d.successor_id);
        } else {
          out.set(extTask.id, {
            task: extTask,
            relation: "prerequisite_of_team",
            bridgeTaskIds: [d.successor_id],
          });
        }
      }
    }
  }
  return [...out.values()];
}

// Selectors
export const selectChildTasks = (state: PmState, parentId: string) =>
  state.tasks.filter((t) => t.parent_task_id === parentId);

export const selectRootTasks = (state: PmState) =>
  state.tasks.filter((t) => t.parent_task_id === null);

// Comments for a task, newest first.
export const selectComments = (state: PmState, taskId: string) =>
  state.comments
    .filter((c) => c.task_id === taskId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

export const selectBuildRecord = (state: PmState, taskId: string) =>
  state.buildRecords.find((b) => b.task_id === taskId) ?? null;

export type { PmState };
