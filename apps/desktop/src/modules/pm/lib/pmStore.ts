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
  TaskLink,
  TaskRow,
  TeamRole,
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
  links: TaskLink[];
  buildRecords: BuildRecord[];
  events: CalendarEvent[];
  // Server-wide hidden subteam ids for THIS project (display-only: filters the
  // sidebar nav list, never task data/membership/permissions). Absence = shown.
  hiddenSubteams: string[];
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
  // The signed-in user's PM role per project (admin/lead/engineer/viewer).
  roles: Record<string, TeamRole>;
  // A BACKGROUND refresh (probe/realtime/focus/backstop re-hydrate) passes this
  // so it does NOT wipe a pending `lastWriteError`. A failed write surfaces the
  // "Change not saved" toast; a refresh firing right after must keep showing it
  // until the user dismisses it / it auto-expires, instead of silently clearing
  // it. The initial cold load leaves it false so a fresh sign-in starts clean.
  preserveWriteError?: boolean;
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
    links: s.links,
    buildRecords: s.buildRecords,
    events: s.events,
    hiddenSubteams: s.hiddenSubteams,
  };
}

// Load a ProjectData record into the flat fields (fresh array instances so
// later mutations never alias another project's stored arrays).
//
// Every field is spread through `?? []` defensively: a ProjectData can come from
// a persisted localStorage snapshot written by an OLDER app version that predates
// a field (e.g. `links`, added in 4.4.3). Without the guard, `[...undefined]`
// throws "Spread syntax requires ...iterable" and the whole PM module dies on
// load. The snapshot version gate (SNAPSHOT_VERSION) also rejects stale snapshots,
// but this keeps hydration crash-proof regardless of where the record came from.
function loadFlat(d: ProjectData) {
  return {
    tasks: [...(d.tasks ?? [])],
    subteams: [...(d.subteams ?? [])],
    subsystems: [...(d.subsystems ?? [])],
    users: [...(d.users ?? [])],
    dependencies: [...(d.dependencies ?? [])],
    milestones: [...(d.milestones ?? [])],
    pages: [...(d.pages ?? [])],
    blocks: [...(d.blocks ?? [])],
    activity: [...(d.activity ?? [])],
    vendors: [...(d.vendors ?? [])],
    comments: [...(d.comments ?? [])],
    links: [...(d.links ?? [])],
    buildRecords: [...(d.buildRecords ?? [])],
    events: [...(d.events ?? [])],
    hiddenSubteams: [...(d.hiddenSubteams ?? [])],
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
    links: [],
    buildRecords: [],
    events: [],
    hiddenSubteams: [],
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
  // Number of optimistic writes currently persisting. A background refresh skips
  // while this is > 0 so it never clobbers an in-flight optimistic edit.
  inFlightWrites: number;
  // Monotonic counter bumped when any persist STARTS — lets the auto-refresh
  // detect a write that began during its fetch and skip the now-stale re-hydrate.
  writeEpoch: number;
  // The signed-in user's PM role per project; drives admin-only UI + edit gating.
  projectRoles: Record<string, TeamRole>;

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
  links: TaskLink[];
  buildRecords: BuildRecord[];
  events: CalendarEvent[];
  // Server-wide hidden subteam ids for the ACTIVE project (display-only; mirrors
  // the active ProjectData like the other flat fields). Drives the sidebar's
  // hidden-subteam filter via the pure `visibleSubteams` selector.
  hiddenSubteams: string[];

  // UI state: the task whose detail sheet is open, or null
  selectedTaskId: string | null;
  selectTask: (id: string | null) => void;

  // UI state: whether the Deadlines report window is open. Session-only.
  reportOpen: boolean;
  setReportOpen: (open: boolean) => void;

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
  // Server-backed season create: calls the admin-only `create_project` RPC, then
  // does a full authoritative workspace reload (via `reloadWorkspace`, registered
  // by PmModule) so the new project + its empty data land from the server, and
  // switches to it. Resolves with the new project id; rejects with a friendly
  // Error on failure (not admin / duplicate car code / no reload wired). REPLACES
  // the old client-only addProject, whose localStorage-only project was silently
  // destroyed on the next background hydrate.
  createProject: (name: string, carYear: number, carCode: string) => Promise<string>;
  // Registered by PmModule with its `loadWorkspace` + `hydrate` reload. Lets a
  // store action force a full authoritative re-pull (the SAME path the probe /
  // realtime / focus refresh uses) without duplicating it or importing data.ts
  // (which would create a cycle — data.ts imports types from this module). Null
  // in tests / before mount: createProject then surfaces a clear error.
  reloadWorkspace: (() => Promise<void>) | null;
  registerReloadWorkspace: (fn: (() => Promise<void>) | null) => void;
  renameProject: (id: string, patch: { name?: string; description?: string | null }) => void;
  // Reconcile browser-persisted project list + active id over the seed.
  reconcilePersisted: (persisted: {
    projects?: Project[];
    activeProjectId?: string;
  }) => void;

  // Subteam mutations
  addSubteam: (subteam: Subteam) => void;
  updateSubteam: (id: string, patch: Partial<Subteam>) => void;
  // Non-destructive: sole-membership tasks are REASSIGNED to `fallbackId`
  // instead of being deleted. The caller (Sidebar) must pass a fallback subteam.
  deleteSubteam: (id: string, fallbackId: string) => void;
  // Set (or clear with null) a subteam's display icon. Persisted server-wide via
  // the capability-gated `pm.set_subteam_icon` RPC (any lead/exec/owner); null
  // reverts to the auto-derived glyph.
  setSubteamIcon: (id: string, icon: string | null) => void;

  // DISPLAY-ONLY server-wide subteam hide/show for the ACTIVE project's sidebar
  // nav list. Gated server-side by `pm.manage_project_subteams` (the RPC re-checks
  // the capability and is the source of truth). These ONLY change what the sidebar
  // lists — never task assignment, membership, or permissions. Optimistically
  // updates `hiddenSubteams` + the active ProjectData; realtime reconciles.
  hideProjectSubteam: (subteamId: string) => void;
  showProjectSubteam: (subteamId: string) => void;

  // Subsystem mutations (admin-gated). Single primary subteam (schema limit);
  // delete relies on the tasks.subsystem_id ON DELETE SET NULL FK.
  addSubsystem: (subsystem: Subsystem) => void;
  updateSubsystem: (id: string, patch: Partial<Subsystem>) => void;
  removeSubsystem: (id: string) => void;

  // Task mutations. `extra` lets the create dialog hand off ADDITIONAL subteam
  // memberships and dependencies so they persist in the SAME persist() as the
  // task INSERT — sequentially AFTER insertTask commits — instead of racing
  // separate fire-and-forget writes that can hit Postgres before the task row
  // exists and violate the FK (bug H-10).
  addTask: (
    task: TaskRow,
    extra?: {
      extraSubteamIds?: string[];
      prerequisiteIds?: string[];
      dependentIds?: string[];
    },
  ) => void;
  updateTask: (id: string, patch: Partial<TaskRow>, opts?: { withHistory?: boolean }) => void;
  bulkUpdateTasks: (
    ids: string[],
    patch: Partial<TaskRow>,
    opts?: { withHistory?: boolean },
  ) => void;
  deleteTask: (id: string) => void;

  // Multi-subteam membership mutations
  addTaskSubteam: (taskId: string, subteamId: string) => void;
  removeTaskSubteam: (taskId: string, subteamId: string) => void;
  setPrimarySubteam: (taskId: string, subteamId: string) => void;
  addTaskOwner: (taskId: string, ownerId: string) => void;
  removeTaskOwner: (taskId: string, ownerId: string) => void;
  setPrimaryOwner: (taskId: string, ownerId: string) => void;
  // Re-home the PRIMARY membership onto a DIFFERENT subteam, dropping the old
  // primary entirely (used to evict the catch-all "Unknown" subteam from a task).
  reassignPrimarySubteam: (taskId: string, newSubteamId: string) => void;

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
  addLink: (link: TaskLink) => void;
  deleteLink: (id: string) => void;

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

// All subteam ids a task is tagged to (every membership, not just the primary)
// so activity entries surface in EVERY member team's feed. Falls back to the
// primary subteam_id if the membership list is somehow empty.
function subteamsForTask(task: TaskRow | undefined): string[] {
  if (!task) return [];
  const ids = (task.subteams ?? []).map((s) => s.id);
  return ids.length > 0 ? ids : [task.subteam_id];
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
    // Keep the denormalized membership list aligned with the primary mirror: a
    // direct subteam_id move (bulk "move to team") re-homes the PRIMARY slot.
    // Replace the old primary entry with the new subteam (or prepend it if it
    // wasn't already a member) and keep it primary-first. Mirrors the DB trigger
    // that re-syncs task_subteams' is_primary when subteam_id changes.
    if (st && patch.subteam_id !== current.subteam_id) {
      const rest = (current.subteams ?? []).filter(
        (s) => s.id !== current.subteam_id && s.id !== st.id,
      );
      next.subteams = [st, ...rest];
    }
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
    const newOwner = patch.owner_id
      ? state.users.find((x) => x.id === patch.owner_id) ?? null
      : null;
    next.owner = newOwner;
    // Keep the owners list aligned with the primary mirror, like subteams: a
    // scalar owner change re-homes the PRIMARY slot. Drop the old primary and any
    // existing copy of the new owner, then lead with the new primary (if any).
    const rest = (current.owners ?? []).filter(
      (u) => u.id !== current.owner_id && u.id !== patch.owner_id,
    );
    next.owners = newOwner ? [newOwner, ...rest] : rest;
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
    // Capture the project the write targets. A rollback restores this project's
    // flat fields (the snapshot was taken from it), so if the user switched to a
    // different project before the write rejected, rolling back would overwrite
    // the NOW-active project's data with the old one's. Skip the rollback in that
    // case — the stale flat fields aren't on screen anymore (the outgoing
    // project's snapshotFlat already captured the optimistic state on switch).
    const proj = get().activeProjectId;
    set((s) => ({ inFlightWrites: s.inFlightWrites + 1, writeEpoch: s.writeEpoch + 1 }));
    void run(client)
      .catch((err: unknown) => {
        if (get().activeProjectId !== proj) return;
        rollback();
        const message = err instanceof Error ? err.message : String(err);
        set({ lastWriteError: { message, at: Date.now() } });
      })
      .finally(() => {
        set((s) => ({ inFlightWrites: Math.max(0, s.inFlightWrites - 1) }));
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
    reloadWorkspace: null,
    registerReloadWorkspace: (fn) => set({ reloadWorkspace: fn }),
    lastWriteError: null,
    clearWriteError: () => set({ lastWriteError: null }),
    inFlightWrites: 0,
    writeEpoch: 0,
    projectRoles: {},
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
    links: [],
    buildRecords: [],
    events: [],
    hiddenSubteams: [],

    selectedTaskId: null,
    selectTask: (id) => set({ selectedTaskId: id }),

    reportOpen: false,
    setReportOpen: (open) => set({ reportOpen: open }),

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
          projectRoles: input.roles,
          // A background refresh keeps any pending write error visible; only a
          // fresh (cold) load resets it (bug: refresh suppressing the toast).
          ...(input.preserveWriteError ? {} : { lastWriteError: null }),
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

    // Server-backed season create. pm.projects has NO client INSERT policy, so
    // creation goes through the admin-only `create_project` RPC (which atomically
    // inserts the project + the caller's admin membership). A new season needs a
    // year and a UNIQUE car code (e.g. "SDM28"). On success we do a FULL workspace
    // reload through the SAME loadWorkspace + hydrate path the background refresh
    // uses (registered as `reloadWorkspace` by PmModule), so the new project and
    // its empty per-project data arrive authoritatively from the server — then we
    // switch to it. This replaces the old client-only addProject, whose project
    // existed only in localStorage and was silently wiped on the next hydrate.
    createProject: async (name, carYear, carCode) => {
      const { client, reloadWorkspace } = get();
      if (!client) {
        throw new Error("You must be signed in to create a season.");
      }
      const id = await db.createProject(
        client,
        name.trim(),
        carYear,
        carCode.trim().toUpperCase(),
      );
      // Re-pull the whole workspace so the new project + its (empty) data land
      // from the server. If the reload isn't wired (tests / pre-mount), the create
      // still succeeded server-side; surface that so the caller can prompt a
      // reload rather than us inventing a fragile local-only insert path.
      if (!reloadWorkspace) {
        throw new Error(
          "Season created. Reload to see it (workspace refresh is not available).",
        );
      }
      await reloadWorkspace();
      // The reload hydrated the new project into projectData; make it active.
      if (get().projectData[id]) {
        get().setActiveProject(id);
      }
      return id;
    },

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

    // NOTE: the "recreate empty" branch below used to revive client-only
    // projects created by the old addProject (which never reached the server).
    // Now that createProject is server-backed and always reloads from the `pm`
    // schema, no new client-only project enters the persisted list, so that
    // branch is effectively dead for fresh creates. It's left in place as a
    // harmless guard for any stale localStorage list written by an older build.
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

    addSubsystem: (subsystem) => {
      const snap = { subsystems: get().subsystems };
      set((s) => ({ subsystems: [...s.subsystems, subsystem] }));
      persist((c) => db.insertSubsystem(c, subsystem), () => set(snap));
    },

    updateSubsystem: (id, patch) => {
      const current = get().subsystems.find((x) => x.id === id);
      if (!current) return;
      const snap = { subsystems: get().subsystems, tasks: get().tasks };
      set((s) => {
        const next: Subsystem = { ...current, ...patch };
        return {
          subsystems: s.subsystems.map((x) => (x.id === id ? next : x)),
          // Tasks embed a copy of their subsystem — re-embed the updated record.
          tasks: s.tasks.map((t) => (t.subsystem_id === id ? { ...t, subsystem: next } : t)),
        };
      });
      persist((c) => db.patchSubsystem(c, id, patch), () => set(snap));
    },

    removeSubsystem: (id) => {
      const removed = get().subsystems.find((x) => x.id === id);
      if (!removed) return;
      const snap = { subsystems: get().subsystems, tasks: get().tasks };
      set((s) => ({
        subsystems: s.subsystems.filter((x) => x.id !== id),
        // FK is ON DELETE SET NULL — mirror that locally so tasks drop the link.
        tasks: s.tasks.map((t) =>
          t.subsystem_id === id ? { ...t, subsystem_id: null, subsystem: null } : t,
        ),
      }));
      persist((c) => db.removeSubsystem(c, id), () => set(snap));
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

    setSubteamIcon: (id, icon) => {
      const current = get().subteams.find((x) => x.id === id);
      if (!current) return;
      const snap = { subteams: get().subteams, tasks: get().tasks, activity: get().activity };
      set((s) => {
        const next: Subteam = { ...current, icon };
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
            payload: { icon },
          }),
        };
      });
      persist((c) => db.setSubteamIcon(c, id, icon), () => set(snap));
    },

    deleteSubteam: (id, fallbackId) => {
      const removed = get().subteams.find((x) => x.id === id);
      if (!removed) return;
      // The fallback must be a real, DIFFERENT subteam — sole-membership tasks
      // are re-homed onto it so they're never left orphaned (or deleted).
      if (fallbackId === id) return;
      const fallback =
        get().subteams.find((x) => x.id === fallbackId) ??
        get().baselineOrg.subteams.find((x) => x.id === fallbackId);
      if (!fallback) return;
      const snap = {
        subteams: get().subteams,
        subsystems: get().subsystems,
        tasks: get().tasks,
        dependencies: get().dependencies,
        pages: get().pages,
        activity: get().activity,
      };

      // Partition tasks that touch the doomed subteam into:
      //  - SOLE: the subteam is their only membership → REASSIGN their primary to
      //    the fallback subteam (the task survives, just re-homed).
      //  - REASSIGN: co-owned AND the subteam was the PRIMARY → promote another
      //    existing membership to primary (re-homes tasks.subteam_id off the FK).
      //  - DEMEMBER: co-owned, non-primary → just drop the membership.
      const tasksNow = get().tasks;
      const memberOf = (t: TaskRow) =>
        (t.subteams ?? []).length > 0
          ? t.subteams.some((s) => s.id === id)
          : t.subteam_id === id;
      // Sole-membership tasks re-homed onto the fallback subteam.
      const sole: string[] = [];
      const reassign: Array<{ taskId: string; newPrimaryId: string }> = [];
      const demember: string[] = []; // co-owned task ids losing this membership
      for (const t of tasksNow) {
        if (!memberOf(t)) continue;
        const members = (t.subteams ?? []).length > 0 ? t.subteams : [t.subteam];
        const survivors = members.filter((s) => s.id !== id);
        if (survivors.length === 0) {
          sole.push(t.id);
        } else {
          demember.push(t.id);
          if (t.subteam_id === id) {
            reassign.push({ taskId: t.id, newPrimaryId: survivors[0]!.id });
          }
        }
      }
      const soleSet = new Set(sole);
      // Sole/reassign tasks lose their subsystem (it belonged to the doomed
      // subteam). The store nulls subsystem_id below; capture which of those
      // tasks actually HAD a subsystem so we can null it server-side explicitly
      // rather than relying solely on a DB cascade firing.
      const clearedSubsystem = tasksNow
        .filter(
          (t) =>
            (soleSet.has(t.id) || (t.subteam_id === id && !soleSet.has(t.id))) &&
            t.subsystem_id != null,
        )
        .map((t) => t.id);

      set((s) => {
        const tasks = s.tasks.map((t) => {
          if (!memberOf(t)) return t;
          // 1. Sole-membership task → re-home its single membership to the fallback.
          if (soleSet.has(t.id)) {
            return {
              ...t,
              subteam_id: fallback.id,
              subteam: fallback,
              subteams: [fallback],
              // The old subteam's subsystem can't belong to the fallback.
              subsystem_id: null,
              subsystem: null,
            };
          }
          // 2. Co-owned task → strip the membership; if it was primary, promote
          //    the first survivor.
          const members = (t.subteams ?? []).length > 0 ? t.subteams : [t.subteam];
          const survivors = members.filter((x) => x.id !== id);
          if (t.subteam_id === id) {
            const promoted = survivors[0]!;
            return {
              ...t,
              subteam_id: promoted.id,
              subteam: promoted,
              subteams: survivors,
              // The old primary's subsystem can't belong to the promoted subteam
              // (the doomed subteam's subsystems are removed below + DB cascades).
              subsystem_id: null,
              subsystem: null,
            };
          }
          return { ...t, subteams: survivors };
        });
        return {
          subteams: s.subteams.filter((x) => x.id !== id),
          subsystems: s.subsystems.filter((x) => x.subteam_id !== id),
          tasks,
          // No tasks are deleted now, so dependencies are untouched.
          dependencies: s.dependencies,
          pages: s.pages.map((p) => (p.subteam_id === id ? { ...p, subteam_id: null } : p)),
          activity: logActivity(s, {
            action: "deleted",
            target_type: "subteam",
            target_id: id,
            target_name: removed.name,
            subteam_ids: [id],
            payload: { reassigned_to: fallbackId },
          }),
        };
      });

      // Persist order is FK-critical: reassign tasks.subteam_id OFF the doomed
      // subteam BEFORE removeSubteam (the tasks.subteam_id → subteams FK would
      // otherwise block the delete). For sole-membership tasks we attach+flip the
      // fallback primary (set_task_primary_subteam) THEN drop the doomed
      // membership, so the task always retains exactly one membership. Co-owned
      // tasks promote a survivor / demember as before. No task is ever deleted.
      persist(
        async (c) => {
          for (const taskId of sole) {
            await db.setPrimarySubteam(c, taskId, fallbackId);
            await db.removeTaskSubteam(c, taskId, id);
          }
          for (const r of reassign) {
            await db.setPrimarySubteam(c, r.taskId, r.newPrimaryId);
          }
          // The re-homed primary's old subsystem can't belong to its new subteam,
          // so null it explicitly (matches the in-store update) rather than
          // relying solely on a DB cascade.
          for (const taskId of clearedSubsystem) {
            await db.patchTask(c, taskId, { subsystem_id: null });
          }
          for (const taskId of demember) {
            await db.removeTaskSubteam(c, taskId, id);
          }
          await db.removeSubteam(c, id);
        },
        () => set(snap),
      );
    },

    // Server-wide DISPLAY hide of a subteam from THIS project's sidebar nav list.
    // No-op if already hidden. Optimistically appends to `hiddenSubteams` (+ the
    // active ProjectData) and persists via the capability-gated RPC; the realtime
    // refresh reconciles the authoritative set. DISPLAY-ONLY — no task/membership
    // mutation happens here.
    hideProjectSubteam: (subteamId) => {
      if (get().hiddenSubteams.includes(subteamId)) return;
      const projectId = get().activeProjectId;
      const snap = { hiddenSubteams: get().hiddenSubteams };
      set((s) => {
        const hiddenSubteams = [...s.hiddenSubteams, subteamId];
        const prev = s.projectData[s.activeProjectId];
        const projectData = prev
          ? { ...s.projectData, [s.activeProjectId]: { ...prev, hiddenSubteams } }
          : s.projectData;
        return { hiddenSubteams, projectData };
      });
      persist(
        (c) => db.hideProjectSubteam(c, projectId, subteamId),
        () => set(snap),
      );
    },

    // Server-wide DISPLAY un-hide (removes the row so the subteam shows for
    // everyone again). Mirror of hideProjectSubteam.
    showProjectSubteam: (subteamId) => {
      if (!get().hiddenSubteams.includes(subteamId)) return;
      const projectId = get().activeProjectId;
      const snap = { hiddenSubteams: get().hiddenSubteams };
      set((s) => {
        const hiddenSubteams = s.hiddenSubteams.filter((x) => x !== subteamId);
        const prev = s.projectData[s.activeProjectId];
        const projectData = prev
          ? { ...s.projectData, [s.activeProjectId]: { ...prev, hiddenSubteams } }
          : s.projectData;
        return { hiddenSubteams, projectData };
      });
      persist(
        (c) => db.showProjectSubteam(c, projectId, subteamId),
        () => set(snap),
      );
    },

    addTask: (task, extra) => {
      // Every task carries at least its primary subteam in the membership list.
      // The dialog may pass `subteams`; default to [primary] so the new row is
      // valid for scoping/activity even before any additional membership writes.
      const seeded: TaskRow = {
        ...task,
        // Stamp the creator optimistically so the new row is immediately editable
        // by its author (the DB writes the same value via `default auth.uid()` on
        // INSERT). Matches the "you can edit tasks you created" branch of the
        // edit-permission check, so a freshly created task isn't read-only until
        // the next reload.
        created_by: task.created_by ?? get().currentUserId ?? null,
        subteams:
          task.subteams && task.subteams.length > 0 ? task.subteams : [task.subteam],
        // Seed the owners list from the (primary) owner so a freshly created task
        // shows its owner immediately; the DB trigger seeds the same primary row.
        owners:
          task.owners && task.owners.length > 0
            ? task.owners
            : task.owner
              ? [task.owner]
              : [],
      };

      // Resolve any ADDITIONAL subteam memberships the dialog handed off, folding
      // them into the seeded membership list so the new row shows them right away.
      // Skip the primary and de-dupe; persist them sequentially below.
      const resolveSubteam = (id: string) =>
        get().subteams.find((x) => x.id === id) ??
        get().baselineOrg.subteams.find((x) => x.id === id) ??
        null;
      const seenSubteam = new Set(seeded.subteams.map((s) => s.id));
      const extraSubteams: Subteam[] = [];
      for (const id of extra?.extraSubteamIds ?? []) {
        if (id === seeded.subteam_id || seenSubteam.has(id)) continue;
        const st = resolveSubteam(id);
        if (!st) continue;
        seenSubteam.add(id);
        extraSubteams.push(st);
      }
      seeded.subteams = [...seeded.subteams, ...extraSubteams];

      // Build the dependency rows now that the task id exists. Dedupe against
      // self and any reverse already implied; the optimistic store apply + the
      // sequential persist both use this list so they can't drift.
      const newDeps: TaskDependency[] = [];
      const seenDep = new Set<string>();
      const pushDep = (predecessor_id: string, successor_id: string) => {
        if (predecessor_id === successor_id) return;
        const key = `${predecessor_id}->${successor_id}`;
        if (seenDep.has(key)) return;
        seenDep.add(key);
        newDeps.push({ predecessor_id, successor_id, dep_type: "FS", lag_days: 0 });
      };
      for (const pid of extra?.prerequisiteIds ?? []) pushDep(pid, seeded.id);
      for (const did of extra?.dependentIds ?? []) pushDep(seeded.id, did);

      const snap = {
        tasks: get().tasks,
        activity: get().activity,
        dependencies: get().dependencies,
      };
      set((s) => ({
        tasks: [seeded, ...s.tasks],
        dependencies: [...s.dependencies, ...newDeps],
        activity: logActivity(s, {
          action: "created",
          target_type: "task",
          target_id: seeded.id,
          target_name: seeded.title,
          subteam_ids: subteamsForTask(seeded),
          payload: { type: seeded.type },
        }),
      }));
      // The DB auto-seeds the PRIMARY membership from subteam_id on INSERT, so we
      // only persist any ADDITIONAL memberships the task was created with.
      const extras = seeded.subteams.filter((s) => s.id !== seeded.subteam_id);
      // Same for owners: the DB trigger seeds the PRIMARY owner from owner_id, so
      // we only persist the ADDITIONAL co-owners the task was created with.
      const ownerExtras = seeded.owners.filter((u) => u.id !== seeded.owner_id);
      persist(
        async (c) => {
          // Order is FK-critical: the task row MUST commit before any membership
          // or dependency that references it (bug H-10 — these used to be
          // separate fire-and-forget writes that raced the INSERT).
          await db.insertTask(c, seeded);
          for (const st of extras) await db.insertTaskSubteam(c, seeded.id, st.id);
          for (const u of ownerExtras) await db.insertTaskOwner(c, seeded.id, u.id);
          for (const d of newDeps) await db.insertDependency(c, d);
        },
        () => set(snap),
      );
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

    addTaskSubteam: (taskId, subteamId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Already a member → no-op (don't double-insert, which the unique PK rejects).
      if ((task.subteams ?? []).some((s) => s.id === subteamId)) return;
      // Resolve the Subteam record from the active org (fall back to baseline).
      const st =
        get().subteams.find((x) => x.id === subteamId) ??
        get().baselineOrg.subteams.find((x) => x.id === subteamId);
      if (!st) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) =>
          t.id === taskId ? { ...t, subteams: [...(t.subteams ?? [task.subteam]), st] } : t,
        );
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: [subteamId],
            payload: { added_subteam: subteamId },
          }),
        };
      });
      persist((c) => db.insertTaskSubteam(c, taskId, subteamId), () => set(snap));
    },

    removeTaskSubteam: (taskId, subteamId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      // GUARD: the primary membership can never be removed directly — reassign
      // the primary first (via setPrimarySubteam) and then remove.
      if (subteamId === task.subteam_id) return;
      if (!(task.subteams ?? []).some((s) => s.id === subteamId)) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) =>
          t.id === taskId
            ? { ...t, subteams: (t.subteams ?? []).filter((x) => x.id !== subteamId) }
            : t,
        );
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: [subteamId],
            payload: { removed_subteam: subteamId },
          }),
        };
      });
      persist((c) => db.removeTaskSubteam(c, taskId, subteamId), () => set(snap));
    },

    setPrimarySubteam: (taskId, subteamId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Must already be a membership — promotion only flips an existing member to
      // primary; it never adds a brand-new team (use addTaskSubteam for that).
      if (!(task.subteams ?? []).some((s) => s.id === subteamId)) return;
      if (subteamId === task.subteam_id) return; // already primary — no-op
      const st =
        get().subteams.find((x) => x.id === subteamId) ??
        get().baselineOrg.subteams.find((x) => x.id === subteamId);
      if (!st) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) => {
          if (t.id !== taskId) return t;
          // Reorder primary-first and re-home the embedded primary subteam/id.
          const rest = (t.subteams ?? []).filter((x) => x.id !== subteamId);
          return { ...t, subteam_id: subteamId, subteam: st, subteams: [st, ...rest] };
        });
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: [subteamId],
            payload: { primary_subteam: subteamId },
          }),
        };
      });
      persist((c) => db.setPrimarySubteam(c, taskId, subteamId), () => set(snap));
    },

    addTaskOwner: (taskId, ownerId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Already an owner → no-op (the unique PK would reject a double-insert).
      if ((task.owners ?? []).some((u) => u.id === ownerId)) return;
      const u =
        get().users.find((x) => x.id === ownerId) ??
        get().baselineOrg.users.find((x) => x.id === ownerId);
      if (!u) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) =>
          t.id === taskId ? { ...t, owners: [...(t.owners ?? []), u] } : t,
        );
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: subteamsForTask(task),
            payload: { added_owner: ownerId },
          }),
        };
      });
      persist((c) => db.insertTaskOwner(c, taskId, ownerId), () => set(snap));
    },

    removeTaskOwner: (taskId, ownerId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (!(task.owners ?? []).some((u) => u.id === ownerId)) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) => {
          if (t.id !== taskId) return t;
          const owners = (t.owners ?? []).filter((u) => u.id !== ownerId);
          // Removing the PRIMARY owner clears the primary mirror — the DB trigger
          // does the same (with no is_primary row left, tasks.owner_id -> null).
          if (ownerId === t.owner_id) {
            return { ...t, owner_id: null, owner: null, owners };
          }
          return { ...t, owners };
        });
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: subteamsForTask(task),
            payload: { removed_owner: ownerId },
          }),
        };
      });
      persist((c) => db.removeTaskOwner(c, taskId, ownerId), () => set(snap));
    },

    setPrimaryOwner: (taskId, ownerId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (ownerId === task.owner_id) return; // already primary — no-op
      const u =
        get().users.find((x) => x.id === ownerId) ??
        get().baselineOrg.users.find((x) => x.id === ownerId) ??
        (task.owners ?? []).find((x) => x.id === ownerId);
      if (!u) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) => {
          if (t.id !== taskId) return t;
          // Reorder primary-first and re-home the embedded primary owner/id. The
          // RPC adds the membership if it wasn't already one.
          const rest = (t.owners ?? []).filter((x) => x.id !== ownerId);
          return { ...t, owner_id: ownerId, owner: u, owners: [u, ...rest] };
        });
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: subteamsForTask(task),
            payload: { primary_owner: ownerId },
          }),
        };
      });
      persist((c) => db.setPrimaryOwner(c, taskId, ownerId), () => set(snap));
    },

    reassignPrimarySubteam: (taskId, newSubteamId) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      const oldPrimaryId = task.subteam_id;
      // No-op if the target already IS the primary — there'd be nothing to evict.
      if (newSubteamId === oldPrimaryId) return;
      const st =
        get().subteams.find((x) => x.id === newSubteamId) ??
        get().baselineOrg.subteams.find((x) => x.id === newSubteamId);
      if (!st) return;
      const snap = { tasks: get().tasks, activity: get().activity };
      set((s) => {
        const tasks = s.tasks.map((t) => {
          if (t.id !== taskId) return t;
          // The surviving memberships are everything EXCEPT the old primary and
          // any pre-existing copy of the new subteam; the new subteam leads.
          const rest = (t.subteams ?? [t.subteam]).filter(
            (x) => x.id !== oldPrimaryId && x.id !== st.id,
          );
          return {
            ...t,
            subteam_id: st.id,
            subteam: st,
            subteams: [st, ...rest],
            // The old primary's subsystem can't belong to the new subteam.
            subsystem_id: null,
            subsystem: null,
          };
        });
        return {
          tasks,
          activity: logActivity(s, {
            action: "updated",
            target_type: "task",
            target_id: taskId,
            target_name: task.title,
            subteam_ids: [newSubteamId, oldPrimaryId],
            payload: { reassigned_primary_subteam: newSubteamId, dropped_subteam: oldPrimaryId },
          }),
        };
      });
      // Persist order matters: set_task_primary_subteam on-conflict-attaches the
      // new subteam (if it wasn't already a member) and flips is_primary onto it,
      // demoting the old primary to a regular membership. ONLY THEN can we drop
      // the old catch-all via removeTaskSubteam (which refuses a still-primary id).
      // This never leaves the task with zero memberships — the new primary is
      // attached before the old one is removed.
      persist(
        async (c) => {
          await db.setPrimarySubteam(c, taskId, newSubteamId);
          await db.removeTaskSubteam(c, taskId, oldPrimaryId);
          if (task.subsystem_id != null) await db.patchTask(c, taskId, { subsystem_id: null });
        },
        () => set(snap),
      );
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

    addLink: (link) => {
      const snap = { links: get().links };
      set((s) => ({ links: [link, ...s.links] }));
      persist((client) => db.insertTaskLink(client, link), () => set(snap));
    },

    deleteLink: (id) => {
      const snap = { links: get().links };
      set((s) => ({ links: s.links.filter((l) => l.id !== id) }));
      persist((client) => db.removeTaskLink(client, id), () => set(snap));
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
  primaryOnly = false,
): ScopedTask[] {
  // A task is "owned" by a subteam if that subteam is ANY of its memberships,
  // not just the primary. A multi-subteam task therefore appears as owned in
  // EVERY member team's scoped view. Falls back to the primary subteam_id for
  // tasks that somehow carry no membership list.
  const isDefaultMember = (t: TaskRow): boolean =>
    (t.subteams ?? []).length > 0
      ? t.subteams.some((s) => s.id === subteamId)
      : t.subteam_id === subteamId;
  // primaryOnly (the "primary subteam" view preference) tightens ownership to the
  // PRIMARY subteam only — a subteam stops seeing tasks where it's merely a
  // secondary contributor. It is a STRICT SUBSET of the default rule: we require
  // isDefaultMember AND that the scope is the task's primary subteam. Anchoring on
  // isDefaultMember (not subteam_id alone) means the primaryOnly set can never
  // surface a task the default view hides — even when a task's membership list is
  // inconsistent with its subteam_id. Dropped tasks aren't gone from the app; they
  // may still appear as a dependency bridge below if they connect to the team.
  const isMember = (t: TaskRow): boolean =>
    primaryOnly ? isDefaultMember(t) && t.subteam_id === subteamId : isDefaultMember(t);
  const ownedIds = new Set(tasks.filter(isMember).map((t) => t.id));

  const out = new Map<string, ScopedTask>();
  // Own tasks first
  for (const t of tasks) {
    if (isMember(t)) {
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

// The signed-in user's role in the active project, and an admin convenience.
export const selectMyRole = (state: PmState): TeamRole | null =>
  state.projectRoles[state.activeProjectId] ?? null;
export const selectIsAdmin = (state: PmState): boolean => selectMyRole(state) === "admin";

// Can the signed-in user edit this task, and if not, why not? Mirrors the
// `pm.can_edit_task` RLS function so the UI can disable controls and explain the
// block UP FRONT instead of letting the write fail silently. The DB remains the
// source of truth — `checkAffected` in the write layer is the backstop if this
// and RLS ever disagree.
//
// Any EDITOR (engineer or above) of the project/subteam may edit ANY task in it,
// not just tasks they personally own or created — see the can_edit_task RLS
// migration (2026-06-23). The role here comes from `my_team_roles`, which uses
// the same `user_role_in_project` resolution as RLS (including the global-PDM
// fallback), so engineer→allow matches the broadened RLS for the common case.
// The client can still UNDER-permit: a user whose only editor access is a
// subteam-scoped role (e.g. engineer in a subteam a task is shared into, but a
// lower project role) reads as the lower project role here, because the client
// carries one role per project with no subteam dimension. Subteam roles DO exist
// in prod, so this path is real — but under-permitting only disables a control
// the DB would have allowed; it never over-permits. The reason strings are
// written for an FSAE teammate.
export const selectCanEditTask = (
  state: Pick<PmState, "projectRoles" | "currentUserId">,
  task: Pick<TaskRow, "project_id">,
): { allowed: boolean; reason: string | null } => {
  const role = state.projectRoles[task.project_id] ?? null;
  if (role === "admin" || role === "lead" || role === "engineer") {
    return { allowed: true, reason: null };
  }
  if (role === "viewer") {
    return { allowed: false, reason: "You have view-only access to this project." };
  }
  return { allowed: false, reason: "You don't have access to edit tasks in this project." };
};

export type { PmState };
