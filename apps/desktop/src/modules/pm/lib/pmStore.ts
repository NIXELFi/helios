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
import type { SupabaseClient } from "@helios/auth";
import { create } from "zustand";
import * as db from "./mutations";

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
  // The signed-in Supabase client. Stored so mutations can persist back to the
  // `pm` schema. Null only in tests / when not signed in (mutations stay local).
  client: SupabaseClient | null;
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
// persist to localStorage. Per-project data (tasks, vendors, …) now persists to
// the `pm` schema in Supabase via the mutation actions below.

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

// A write that failed to persist — surfaced to the user via a toast, cleared
// on dismiss or the next successful interaction.
export interface WriteError {
  message: string;
  at: number;
}

// --- Undo/redo command model ------------------------------------------------
// Every task edit (single inline edit OR a bulk edit) is recorded as ONE
// command. Each entry captures, per task, ONLY the columns that actually
// changed: `before` is the pre-image, `after` is the post-image. Undo replays
// `before`; redo replays `after`. Capturing only changed columns keeps the
// inverse minimal and lets the reverse write reuse the same .in() batching.
export interface TaskPatchEntry {
  id: string;
  before: Partial<TaskRow>;
  after: Partial<TaskRow>;
}
export interface BulkPatchCommand {
  kind: "bulkPatch";
  entries: TaskPatchEntry[];
}
export type PmCommand = BulkPatchCommand;

const UNDO_CAP = 100;

// The columns an undo/redo may carry. Embedded objects are derived, not stored.
const PATCHABLE_KEYS = [
  "subteam_id",
  "subsystem_id",
  "owner_id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "start_date",
  "due_date",
  "estimate_days",
  "mrl",
  "on_critical_path",
  "parent_task_id",
] as const;

// Diff a task's current column values against a patch, returning before/after
// images that contain ONLY the columns the patch actually changes. When
// `subteam_id` changes we also record the implicit `subsystem_id` -> null move
// so undo can restore the original subsystem.
function diffTaskPatch(current: TaskRow, patch: Partial<TaskRow>): TaskPatchEntry | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const cur = current as Record<string, unknown>;
  for (const key of PATCHABLE_KEYS) {
    if (!(key in patch)) continue;
    const nextVal = (patch as Record<string, unknown>)[key];
    if (cur[key] === nextVal) continue;
    before[key] = cur[key];
    after[key] = nextVal;
  }
  // Moving subteams nulls the subsystem implicitly — capture it for a faithful undo.
  if ("subteam_id" in after && !("subsystem_id" in after) && cur.subsystem_id != null) {
    before.subsystem_id = cur.subsystem_id;
    after.subsystem_id = null;
  }
  if (Object.keys(after).length === 0) return null;
  return { id: current.id, before, after };
}

// Push a command onto the undo stack (capped), clearing the redo stack. A fresh
// edit always invalidates the redo future. Returns a partial state update.
function pushUndo(
  s: Pick<PmState, "undoStack">,
  command: PmCommand,
): { undoStack: PmCommand[]; redoStack: PmCommand[] } {
  const undoStack = [...s.undoStack, command].slice(-UNDO_CAP);
  return { undoStack, redoStack: [] };
}

// Group entries that share an identical patch so the reverse write can use one
// .in() batch per distinct patch. Heterogeneous prior values therefore fan out
// into a handful of grouped writes rather than one-per-id.
function groupByPatch(
  entries: TaskPatchEntry[],
  pick: (e: TaskPatchEntry) => Partial<TaskRow>,
): Array<{ ids: string[]; patch: Partial<TaskRow> }> {
  const groups = new Map<string, { ids: string[]; patch: Partial<TaskRow> }>();
  for (const e of entries) {
    const patch = pick(e);
    const key = JSON.stringify(patch);
    const g = groups.get(key);
    if (g) g.ids.push(e.id);
    else groups.set(key, { ids: [e.id], patch });
  }
  return [...groups.values()];
}

interface PmState {
  hydrated: boolean;
  projectId: string;
  currentUserId: string;

  // The signed-in Supabase client used to persist mutations. Null = local only.
  client: SupabaseClient | null;
  // Most recent failed write, for the toast. Null when all is well.
  lastWriteError: WriteError | null;
  clearWriteError: () => void;

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

  // Multi-select for bulk edits — session-only, never persisted. The VIEW owns
  // the eligibility rule (owned, non-external rows) and passes the id list in;
  // the store stays dumb about scoping.
  selectedTaskIds: Set<string>;
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  selectAllFiltered: (ids: string[]) => void;

  // Undo/redo — session-only, capped. Both updateTask and bulkUpdateTasks push
  // a command here so Cmd+Z reverses inline edits too.
  undoStack: PmCommand[];
  redoStack: PmCommand[];
  undo: () => void;
  redo: () => void;

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
  updateTask: (id: string, patch: Partial<TaskRow>, opts?: { withHistory?: boolean }) => void;
  bulkUpdateTasks: (
    ids: string[],
    patch: Partial<TaskRow>,
    opts?: { withHistory?: boolean },
  ) => void;
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

// Shared re-embed logic used by BOTH updateTask and bulkUpdateTasks so the two
// can never drift. A TaskRow carries embedded subteam/subsystem/owner objects
// (PostgREST joins on read) that are NOT columns; whenever the corresponding id
// changes we must re-resolve the embedded object from the org arrays. Moving
// subteams ALSO nulls subsystem_id + the embedded subsystem.
function embedTaskPatch(
  state: Pick<PmState, "subteams" | "subsystems" | "users">,
  current: TaskRow,
  patch: Partial<TaskRow>,
): TaskRow {
  const next: TaskRow = { ...current, ...patch };
  if (patch.subteam_id !== undefined) {
    const st = state.subteams.find((x) => x.id === patch.subteam_id);
    if (st) next.subteam = st;
    // A subsystem belongs to its old subteam, so a real team move drops it —
    // unless the same patch explicitly assigns a new subsystem_id.
    if (patch.subteam_id !== current.subteam_id && patch.subsystem_id === undefined) {
      next.subsystem_id = null;
      next.subsystem = null;
    }
  }
  if (patch.subsystem_id !== undefined) {
    next.subsystem = state.subsystems.find((x) => x.id === patch.subsystem_id) ?? null;
  }
  if (patch.owner_id !== undefined) {
    next.owner = state.users.find((x) => x.id === patch.owner_id) ?? null;
  }
  return next;
}

// A bulk subteam move implicitly clears subsystem_id (a subsystem belongs to the
// old subteam). Fold that into the patch so the DB write matches the in-store
// re-embed — otherwise the row keeps a now-orphaned subsystem_id server-side.
function withSubteamMove(patch: Partial<TaskRow>): Partial<TaskRow> {
  if (patch.subteam_id !== undefined && patch.subsystem_id === undefined) {
    return { ...patch, subsystem_id: null };
  }
  return patch;
}

export const usePmStore = create<PmState>((set, get) => {
  // Optimistic-write helper. The action has already applied its change to the
  // store; this fires the matching DB write in the background. If it fails, we
  // restore the captured pre-image (`rollback`) and surface the error. When
  // there's no client (tests / signed-out) the change simply stays in memory.
  function persist(
    run: (client: SupabaseClient) => Promise<void>,
    rollback: () => void,
  ): void {
    const client = get().client;
    if (!client) return;
    void run(client).catch((err: unknown) => {
      rollback();
      const message = err instanceof Error ? err.message : String(err);
      set({ lastWriteError: { message, at: Date.now() } });
    });
  }

  // Replay a command in one direction (undo => `before`, redo => `after`),
  // optimistically updating the store and issuing the reversing DB writes via
  // the SAME persist path so the change is durable. Heterogeneous patches are
  // grouped (one .in() per identical patch) with a per-id patchTask fallback.
  // `withHistory:false` on the inner edits ensures this replay never spawns a
  // fresh undo entry — the stack juggling is done by the caller (undo/redo).
  // `stackSnap` lets undo()/redo() include the pre-images of BOTH stacks in the
  // rollback. They mutate the stacks synchronously before the (async) reversing
  // write; if that write fails we must restore the stacks too, otherwise the
  // command silently jumps from one stack to the other while its data is rolled
  // back — leaving the stacks inconsistent with the on-screen data.
  function applyCommand(
    command: PmCommand,
    dir: "undo" | "redo",
    stackSnap?: { undoStack: PmCommand[]; redoStack: PmCommand[] },
  ): void {
    const pick = (e: TaskPatchEntry) => (dir === "undo" ? e.before : e.after);
    const groups = groupByPatch(command.entries, pick);
    const snap = { tasks: get().tasks, activity: get().activity, ...stackSnap };

    // Optimistic store apply (single set across all groups), no history.
    set((s) => {
      let tasks = s.tasks;
      for (const g of groups) {
        const idSet = new Set(g.ids);
        tasks = tasks.map((t) => (idSet.has(t.id) ? embedTaskPatch(s, t, g.patch) : t));
      }
      const activity = logActivity(s, {
        action: "updated",
        target_type: "task",
        target_id: command.entries[0]!.id,
        target_name: null,
        subteam_ids: [],
        payload: { [dir]: true, count: command.entries.length },
      });
      return { tasks, activity };
    });

    // Reversing DB writes: one .in() per group, or patchTask for singletons.
    persist(async (c) => {
      for (const g of groups) {
        if (g.ids.length === 1) await db.patchTask(c, g.ids[0]!, g.patch);
        else await db.batchPatchTasks(c, g.ids, g.patch);
      }
    }, () => set(snap));
  }

  return {
    hydrated: false,
    projectId: "",
    currentUserId: "",
    client: null,
    lastWriteError: null,
    clearWriteError: () => set({ lastWriteError: null }),
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

    selectedTaskIds: new Set<string>(),
    setSelection: (ids) => set({ selectedTaskIds: new Set(ids) }),
    toggleSelected: (id) =>
      set((s) => {
        const next = new Set(s.selectedTaskIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedTaskIds: next };
      }),
    clearSelection: () => set({ selectedTaskIds: new Set<string>() }),
    selectAllFiltered: (ids) => set({ selectedTaskIds: new Set(ids) }),

    undoStack: [],
    redoStack: [],

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
          client: input.client,
          lastWriteError: null,
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
          selectedTaskIds: new Set<string>(),
          // The undo/redo history references task ids in the OUTGOING project;
          // replaying it after a switch would fire DB writes against rows that
          // are no longer in view. Drop both stacks on every project switch.
          undoStack: [],
          redoStack: [],
          selectedMilestoneId: null,
          ...loadFlat(target),
        };
      }),

    // Note: project CREATE has no client RLS insert path on pm.projects, so a
    // new project lives in localStorage only (re-created empty on next load)
    // until an admin seeds it server-side. Rename DOES persist (see below).
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

    renameProject: (id, patch) => {
      const snap = { projects: get().projects };
      set((s) => {
        const projects = s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
        persistProjects(projects);
        return { projects };
      });
      persist(
        (c) => db.patchProject(c, id, patch),
        () => {
          set(snap);
          persistProjects(snap.projects);
        },
      );
    },

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

    addSubteam: (subteam) => {
      const snap = { subteams: get().subteams, activity: get().activity };
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
      }));
      persist((c) => db.insertSubteam(c, subteam), () => set(snap));
    },

    updateSubteam: (id, patch) => {
      const current = get().subteams.find((x) => x.id === id);
      if (!current) return;
      const snap = { subteams: get().subteams, tasks: get().tasks, activity: get().activity };
      set((s) => {
        const next: Subteam = { ...current, ...patch };
        return {
          subteams: s.subteams.map((x) => (x.id === id ? next : x)),
          // Tasks embed a copy of their subteam — re-embed the updated record.
          tasks: s.tasks.map((t) => (t.subteam_id === id ? { ...t, subteam: next } : t)),
          activity: logActivity(s, {
            action: "updated",
            target_type: "subteam",
            target_id: id,
            target_name: next.name,
            subteam_ids: [id],
            payload: patch,
          }),
        };
      });
      persist((c) => db.patchSubteam(c, id, patch), () => set(snap));
    },

    deleteSubteam: (id) => {
      const removed = get().subteams.find((x) => x.id === id);
      if (!removed) return;
      const snap = {
        subteams: get().subteams,
        subsystems: get().subsystems,
        tasks: get().tasks,
        dependencies: get().dependencies,
        pages: get().pages,
        activity: get().activity,
      };
      set((s) => {
        const removedTaskIds = new Set(
          s.tasks.filter((t) => t.subteam_id === id).map((t) => t.id),
        );
        return {
          subteams: s.subteams.filter((x) => x.id !== id),
          subsystems: s.subsystems.filter((x) => x.subteam_id !== id),
          tasks: s.tasks.filter((t) => t.subteam_id !== id),
          dependencies: s.dependencies.filter(
            (d) =>
              !removedTaskIds.has(d.predecessor_id) && !removedTaskIds.has(d.successor_id),
          ),
          pages: s.pages.map((p) => (p.subteam_id === id ? { ...p, subteam_id: null } : p)),
          activity: logActivity(s, {
            action: "deleted",
            target_type: "subteam",
            target_id: id,
            target_name: removed.name,
            subteam_ids: [id],
            payload: null,
          }),
        };
      });
      persist((c) => db.removeSubteam(c, id), () => set(snap));
    },

    addTask: (task) => {
      const snap = { tasks: get().tasks, activity: get().activity };
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
      }));
      persist((c) => db.insertTask(c, task), () => set(snap));
    },

    updateTask: (id, patch, opts) => {
      const current = get().tasks.find((t) => t.id === id);
      if (!current) return;
      const withHistory = opts?.withHistory !== false;
      // Capture the minimal before/after diff BEFORE mutating, for undo/redo.
      const entry = diffTaskPatch(current, patch);
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const next = embedTaskPatch(s, current, patch);
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

        // Record a 1-entry command so a single inline edit is undoable too.
        const history =
          withHistory && entry
            ? pushUndo(s, { kind: "bulkPatch", entries: [entry] })
            : {};
        return { tasks, activity, ...history };
      });
      persist((c) => db.patchTask(c, id, patch), () => set(snap));
    },

    bulkUpdateTasks: (ids, rawPatch, opts) => {
      const idSet = new Set(ids);
      const targets = get().tasks.filter((t) => idSet.has(t.id));
      if (targets.length === 0) return;
      const withHistory = opts?.withHistory !== false;
      // A bulk subteam move clears subsystem for ALL selected so the store and
      // the single atomic DB write agree (we can't differentiate per-row in one
      // .in() statement). Use the SAME effective patch for diff, embed, write.
      const patch = withSubteamMove(rawPatch);
      // Diff each target so undo can restore heterogeneous prior values.
      const entries = targets
        .map((t) => diffTaskPatch(t, patch))
        .filter((e): e is TaskPatchEntry => e !== null);
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) =>
          idSet.has(t.id) ? embedTaskPatch(s, t, patch) : t,
        );
        // ONE summarizing activity entry to avoid flooding the 250-cap feed.
        const activity = logActivity(s, {
          action: "updated",
          target_type: "task",
          target_id: targets[0]!.id,
          target_name: null,
          subteam_ids: [...new Set(targets.map((t) => t.subteam_id))],
          payload: { patch, count: targets.length },
        });
        const history =
          withHistory && entries.length > 0
            ? pushUndo(s, { kind: "bulkPatch", entries })
            : {};
        return { tasks, activity, ...history };
      });
      // ONE atomic .in() write for the whole batch.
      persist((c) => db.batchPatchTasks(c, ids, patch), () => set(snap));
    },

    undo: () => {
      const stack = get().undoStack;
      const command = stack[stack.length - 1];
      if (!command) return;
      // Capture both stacks BEFORE moving the command across them so a failed
      // reversing write can restore them (keeping the command undoable).
      const stackSnap = { undoStack: get().undoStack, redoStack: get().redoStack };
      set((s) => ({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, command].slice(-UNDO_CAP),
      }));
      applyCommand(command, "undo", stackSnap);
    },

    redo: () => {
      const stack = get().redoStack;
      const command = stack[stack.length - 1];
      if (!command) return;
      const stackSnap = { undoStack: get().undoStack, redoStack: get().redoStack };
      set((s) => ({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, command].slice(-UNDO_CAP),
      }));
      applyCommand(command, "redo", stackSnap);
    },

    deleteTask: (id) => {
      const removed = get().tasks.find((t) => t.id === id);
      if (!removed) return;
      const snap = { tasks: get().tasks, dependencies: get().dependencies, activity: get().activity };
      set((s) => ({
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
      }));
      persist((c) => db.removeTask(c, id), () => set(snap));
    },

    addDependency: (dep) => {
      if (dep.predecessor_id === dep.successor_id) return;
      const deps = get().dependencies;
      const exists = deps.some(
        (d) => d.predecessor_id === dep.predecessor_id && d.successor_id === dep.successor_id,
      );
      if (exists) return;
      const reverseExists = deps.some(
        (d) => d.predecessor_id === dep.successor_id && d.successor_id === dep.predecessor_id,
      );
      if (reverseExists) return;

      const snap = { dependencies: get().dependencies, activity: get().activity };
      set((s) => {
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
      });
      persist((c) => db.insertDependency(c, dep), () => set(snap));
    },

    removeDependency: (predecessorId, successorId) => {
      const exists = get().dependencies.some(
        (d) => d.predecessor_id === predecessorId && d.successor_id === successorId,
      );
      if (!exists) return;
      const snap = { dependencies: get().dependencies, activity: get().activity };
      set((s) => {
        const pred = s.tasks.find((t) => t.id === predecessorId);
        const succ = s.tasks.find((t) => t.id === successorId);
        const teams = new Set<string>();
        if (pred) teams.add(pred.subteam_id);
        if (succ) teams.add(succ.subteam_id);
        return {
          dependencies: s.dependencies.filter(
            (d) => !(d.predecessor_id === predecessorId && d.successor_id === successorId),
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
      });
      persist((c) => db.removeDependency(c, predecessorId, successorId), () => set(snap));
    },

    // Pages/blocks have no live desktop UI yet (ComingSoon), so block edits stay
    // in memory; wire db.* here when the Pages editor ships.
    updateBlock: (id, patch) =>
      set((s) => ({
        blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      })),

    addMilestone: (m) => {
      const snap = { milestones: get().milestones, activity: get().activity };
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
      }));
      persist((c) => db.insertMilestone(c, m), () => set(snap));
    },

    updateMilestone: (id, patch) => {
      const current = get().milestones.find((x) => x.id === id);
      if (!current) return;
      const snap = { milestones: get().milestones, activity: get().activity };
      set((s) => {
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
      });
      persist((c) => db.patchMilestone(c, id, patch), () => set(snap));
    },

    deleteMilestone: (id) => {
      const removed = get().milestones.find((x) => x.id === id);
      if (!removed) return;
      const snap = { milestones: get().milestones, activity: get().activity };
      set((s) => ({
        milestones: s.milestones.filter((m) => m.id !== id),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "milestone",
          target_id: id,
          target_name: removed.name,
          subteam_ids: [],
          payload: null,
        }),
      }));
      persist((c) => db.removeMilestone(c, id), () => set(snap));
    },

    addVendor: (v) => {
      const snap = { vendors: get().vendors, activity: get().activity };
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
      }));
      persist((c) => db.insertVendor(c, v), () => set(snap));
    },

    updateVendor: (id, patch) => {
      const current = get().vendors.find((x) => x.id === id);
      if (!current) return;
      const snap = { vendors: get().vendors, activity: get().activity };
      set((s) => {
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
      });
      persist((c) => db.patchVendor(c, id, patch), () => set(snap));
    },

    deleteVendor: (id) => {
      const removed = get().vendors.find((x) => x.id === id);
      if (!removed) return;
      const snap = { vendors: get().vendors, activity: get().activity };
      set((s) => ({
        vendors: s.vendors.filter((v) => v.id !== id),
        activity: logActivity(s, {
          action: "deleted",
          target_type: "vendor",
          target_id: id,
          target_name: removed.name,
          subteam_ids: [],
          payload: null,
        }),
      }));
      persist((c) => db.removeVendor(c, id), () => set(snap));
    },

    addComment: (c) => {
      const snap = { comments: get().comments };
      set((s) => ({ comments: [c, ...s.comments] }));
      persist((client) => db.insertComment(client, c), () => set(snap));
    },

    deleteComment: (id) => {
      const snap = { comments: get().comments };
      set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
      persist((client) => db.removeComment(client, id), () => set(snap));
    },

    addEvent: (e) => {
      const snap = { events: get().events };
      set((s) => ({
        events: [...s.events, e].sort((a, b) => a.date.localeCompare(b.date)),
      }));
      persist((c) => db.insertEvent(c, e), () => set(snap));
    },

    updateEvent: (id, patch) => {
      const snap = { events: get().events };
      set((s) => ({
        events: s.events
          .map((e) => (e.id === id ? { ...e, ...patch } : e))
          .sort((a, b) => a.date.localeCompare(b.date)),
      }));
      persist((c) => db.patchEvent(c, id, patch), () => set(snap));
    },

    deleteEvent: (id) => {
      const snap = { events: get().events };
      set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
      persist((c) => db.removeEvent(c, id), () => set(snap));
    },

    updateBuildRecord: (taskId, patch) => {
      const snap = { buildRecords: get().buildRecords };
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
      });
      const record = get().buildRecords.find((b) => b.task_id === taskId);
      if (record) persist((c) => db.upsertBuildRecord(c, taskId, record), () => set(snap));
    },

    reviewDrawing: (taskId, review) => {
      const snap = { buildRecords: get().buildRecords, activity: get().activity };
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
      });
      const record = get().buildRecords.find((b) => b.task_id === taskId);
      if (record) persist((c) => db.upsertBuildRecord(c, taskId, record), () => set(snap));
    },
  };
});

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
