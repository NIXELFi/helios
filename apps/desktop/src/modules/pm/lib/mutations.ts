import type { SupabaseClient } from "@helios/auth";
import type {
  BuildRecord,
  CalendarEvent,
  Milestone,
  Project,
  Subteam,
  TaskComment,
  TaskDependency,
  TaskRow,
  Vendor,
} from "@helios/pm-ui";

// Write layer. The mirror of `data.ts`: every function persists one change to
// the `pm` Postgres schema in Supabase, RLS-scoped + role-gated to the signed-in
// member. Each throws on a Postgrest error so the caller (the store) can roll
// back its optimistic update and surface the failure. The `activity` feed is
// written server-side by the `trg_task_activity` trigger on task writes, so it
// is never inserted from here.

const pm = (client: SupabaseClient) => client.schema("pm");

function check(res: { error: { message: string } | null }, what: string): void {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
}

// The `pm.tasks` columns. A TaskRow also carries embedded `subteam`/`subsystem`/
// `owner` objects (PostgREST joins on read) that are NOT columns — project them
// out before writing.
const TASK_COLUMNS = [
  "id",
  "project_id",
  "subteam_id",
  "subsystem_id",
  "parent_task_id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "owner_id",
  "start_date",
  "due_date",
  "estimate_days",
  "mrl",
  "on_critical_path",
] as const;

function taskColumns(t: Partial<TaskRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TASK_COLUMNS) {
    if (key in t) out[key] = (t as Record<string, unknown>)[key];
  }
  return out;
}

// --- Tasks ------------------------------------------------------------------

export async function insertTask(client: SupabaseClient, task: TaskRow): Promise<void> {
  check(await pm(client).from("tasks").insert(taskColumns(task)), "create task");
}

export async function patchTask(
  client: SupabaseClient,
  id: string,
  patch: Partial<TaskRow>,
): Promise<void> {
  check(await pm(client).from("tasks").update(taskColumns(patch)).eq("id", id), "update task");
}

export async function removeTask(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("tasks").delete().eq("id", id), "delete task");
}

// Bulk edit: apply the SAME column patch to many tasks in ONE atomic statement
// (`UPDATE … WHERE id = ANY($ids)`). PostgREST runs it as a single transaction,
// so if RLS denies any row the whole write fails — the store rolls the optimistic
// change back. Callers MUST pre-filter `ids` to rows the member owns.
export async function batchPatchTasks(
  client: SupabaseClient,
  ids: string[],
  patch: Partial<TaskRow>,
): Promise<void> {
  check(
    await pm(client).from("tasks").update(taskColumns(patch)).in("id", ids),
    "update tasks",
  );
}

// --- Dependencies -----------------------------------------------------------

export async function insertDependency(
  client: SupabaseClient,
  dep: TaskDependency,
): Promise<void> {
  check(await pm(client).from("task_dependencies").insert(dep), "create dependency");
}

export async function removeDependency(
  client: SupabaseClient,
  predecessorId: string,
  successorId: string,
): Promise<void> {
  check(
    await pm(client)
      .from("task_dependencies")
      .delete()
      .eq("predecessor_id", predecessorId)
      .eq("successor_id", successorId),
    "delete dependency",
  );
}

// --- Comments ---------------------------------------------------------------

export async function insertComment(client: SupabaseClient, comment: TaskComment): Promise<void> {
  check(await pm(client).from("task_comments").insert(comment), "create comment");
}

export async function removeComment(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("task_comments").delete().eq("id", id), "delete comment");
}

// --- Milestones -------------------------------------------------------------

export async function insertMilestone(client: SupabaseClient, m: Milestone): Promise<void> {
  check(await pm(client).from("milestones").insert(m), "create milestone");
}

export async function patchMilestone(
  client: SupabaseClient,
  id: string,
  patch: Partial<Milestone>,
): Promise<void> {
  check(await pm(client).from("milestones").update(patch).eq("id", id), "update milestone");
}

export async function removeMilestone(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("milestones").delete().eq("id", id), "delete milestone");
}

// --- Vendors ----------------------------------------------------------------

export async function insertVendor(client: SupabaseClient, v: Vendor): Promise<void> {
  check(await pm(client).from("vendors").insert(v), "create vendor");
}

export async function patchVendor(
  client: SupabaseClient,
  id: string,
  patch: Partial<Vendor>,
): Promise<void> {
  check(await pm(client).from("vendors").update(patch).eq("id", id), "update vendor");
}

export async function removeVendor(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("vendors").delete().eq("id", id), "delete vendor");
}

// --- Calendar events --------------------------------------------------------

export async function insertEvent(client: SupabaseClient, e: CalendarEvent): Promise<void> {
  check(await pm(client).from("calendar_events").insert(e), "create event");
}

export async function patchEvent(
  client: SupabaseClient,
  id: string,
  patch: Partial<CalendarEvent>,
): Promise<void> {
  check(await pm(client).from("calendar_events").update(patch).eq("id", id), "update event");
}

export async function removeEvent(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("calendar_events").delete().eq("id", id), "delete event");
}

// --- Subteams (admin-gated) -------------------------------------------------

export async function insertSubteam(client: SupabaseClient, st: Subteam): Promise<void> {
  check(await pm(client).from("subteams").insert(st), "create subteam");
}

export async function patchSubteam(
  client: SupabaseClient,
  id: string,
  patch: Partial<Subteam>,
): Promise<void> {
  check(await pm(client).from("subteams").update(patch).eq("id", id), "update subteam");
}

export async function removeSubteam(client: SupabaseClient, id: string): Promise<void> {
  check(await pm(client).from("subteams").delete().eq("id", id), "delete subteam");
}

// --- Build records ----------------------------------------------------------

// One row per task (task_id PK), so a partial change upserts on conflict.
export async function upsertBuildRecord(
  client: SupabaseClient,
  taskId: string,
  record: Partial<BuildRecord>,
): Promise<void> {
  check(
    await pm(client)
      .from("build_records")
      .upsert({ ...record, task_id: taskId }, { onConflict: "task_id" }),
    "save build record",
  );
}

// --- Projects (rename only — there is no client INSERT policy) ---------------

export async function patchProject(
  client: SupabaseClient,
  id: string,
  patch: Partial<Pick<Project, "name" | "description">>,
): Promise<void> {
  check(await pm(client).from("projects").update(patch).eq("id", id), "rename project");
}
