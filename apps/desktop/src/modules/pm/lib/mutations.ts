import type { SupabaseClient } from "@helios/auth";
import type {
  BuildRecord,
  CalendarEvent,
  Milestone,
  Project,
  Subsystem,
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

// Turn a raw Postgres/PostgREST error into something a teammate can act on.
// `what` is an infinitive describing the attempt ("edit this task"), so the
// messages read as a sentence. The default keeps the underlying text for the
// cases we don't have a friendlier phrasing for.
function humanize(message: string, what: string): string {
  const m = message.toLowerCase();
  if (
    m.includes("row-level security") ||
    m.includes("violates row-level") ||
    m.includes("permission denied") ||
    m.includes("not authorized")
  ) {
    return `You don't have permission to ${what}.`;
  }
  if (m.includes("duplicate key") || m.includes("already exists")) {
    return `Can't ${what}: it already exists.`;
  }
  if (m.includes("foreign key")) {
    return `Can't ${what}: it refers to something that no longer exists.`;
  }
  if (m.includes("violates check constraint")) {
    return `Can't ${what}: that value isn't allowed.`;
  }
  return `Couldn't ${what}: ${message}`;
}

// An insert (or any write where a Postgrest `error` is the only failure signal).
function check(res: { error: { message: string } | null }, what: string): void {
  if (res.error) throw new Error(humanize(res.error.message, what));
}

// An UPDATE/DELETE/upsert that MUST touch an existing row. PostgREST silently
// returns zero rows (HTTP 200, error: null) when an RLS USING clause hides the
// row from the write — so a denied edit looks like it saved and then "reverts"
// on the next reload (the bug behind report 1548ec9e). We chain `.select()` on
// every such write and treat an empty result as a permission/not-found failure
// so the store rolls back and the user is told why, instead of silently losing
// their change.
function checkAffected(
  res: { data: unknown[] | null; error: { message: string } | null },
  what: string,
): void {
  if (res.error) throw new Error(humanize(res.error.message, what));
  if (!res.data || res.data.length === 0) {
    throw new Error(`You don't have permission to ${what} (or it no longer exists).`);
  }
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
  check(await pm(client).from("tasks").insert(taskColumns(task)), "create this task");
}

export async function patchTask(
  client: SupabaseClient,
  id: string,
  patch: Partial<TaskRow>,
): Promise<void> {
  checkAffected(
    await pm(client).from("tasks").update(taskColumns(patch)).eq("id", id).select("id"),
    "edit this task",
  );
}

export async function removeTask(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("tasks").delete().eq("id", id).select("id"),
    "delete this task",
  );
}

// Bulk edit: apply the SAME column patch to many tasks in ONE atomic statement
// (`UPDATE … WHERE id = ANY($ids)`). PostgREST runs it as a single transaction.
// `.select()` returns the rows actually updated — if RLS hides any of them the
// returned set is short (or empty), so a partially/fully denied bulk edit is
// caught here and rolled back instead of silently dropping changes.
export async function batchPatchTasks(
  client: SupabaseClient,
  ids: string[],
  patch: Partial<TaskRow>,
): Promise<void> {
  checkAffected(
    await pm(client).from("tasks").update(taskColumns(patch)).in("id", ids).select("id"),
    "edit these tasks",
  );
}

// --- Task ↔ subteam memberships ---------------------------------------------
// A task can belong to multiple subteams. `pm.task_subteams` is the join table;
// `pm.tasks.subteam_id` stays the denormalized PRIMARY mirror, kept in sync by
// DB triggers. The client only ever writes ADDITIONAL (non-primary) memberships
// — the primary membership is auto-seeded on task INSERT. Flipping the primary
// goes through the `set_task_primary_subteam` RPC, which moves the is_primary
// flag (and re-syncs subteam_id) atomically.

export async function insertTaskSubteam(
  client: SupabaseClient,
  taskId: string,
  subteamId: string,
): Promise<void> {
  check(
    await pm(client)
      .from("task_subteams")
      .insert({ task_id: taskId, subteam_id: subteamId, is_primary: false }),
    "add this subteam to the task",
  );
}

export async function removeTaskSubteam(
  client: SupabaseClient,
  taskId: string,
  subteamId: string,
): Promise<void> {
  checkAffected(
    await pm(client)
      .from("task_subteams")
      .delete()
      .eq("task_id", taskId)
      .eq("subteam_id", subteamId)
      .select("task_id"),
    "remove this subteam from the task",
  );
}

export async function setPrimarySubteam(
  client: SupabaseClient,
  taskId: string,
  subteamId: string,
): Promise<void> {
  check(
    await client
      .schema("pm")
      .rpc("set_task_primary_subteam", { p_task_id: taskId, p_subteam_id: subteamId }),
    "set primary subteam",
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
  checkAffected(
    await pm(client)
      .from("task_dependencies")
      .delete()
      .eq("predecessor_id", predecessorId)
      .eq("successor_id", successorId)
      .select("predecessor_id"),
    "delete this dependency",
  );
}

// --- Comments ---------------------------------------------------------------

export async function insertComment(client: SupabaseClient, comment: TaskComment): Promise<void> {
  check(await pm(client).from("task_comments").insert(comment), "post this comment");
}

export async function removeComment(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("task_comments").delete().eq("id", id).select("id"),
    "delete this comment",
  );
}

// --- Milestones -------------------------------------------------------------

export async function insertMilestone(client: SupabaseClient, m: Milestone): Promise<void> {
  check(await pm(client).from("milestones").insert(m), "create this milestone");
}

export async function patchMilestone(
  client: SupabaseClient,
  id: string,
  patch: Partial<Milestone>,
): Promise<void> {
  checkAffected(
    await pm(client).from("milestones").update(patch).eq("id", id).select("id"),
    "edit this milestone",
  );
}

export async function removeMilestone(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("milestones").delete().eq("id", id).select("id"),
    "delete this milestone",
  );
}

// --- Vendors ----------------------------------------------------------------

export async function insertVendor(client: SupabaseClient, v: Vendor): Promise<void> {
  check(await pm(client).from("vendors").insert(v), "create this vendor");
}

export async function patchVendor(
  client: SupabaseClient,
  id: string,
  patch: Partial<Vendor>,
): Promise<void> {
  checkAffected(
    await pm(client).from("vendors").update(patch).eq("id", id).select("id"),
    "edit this vendor",
  );
}

export async function removeVendor(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("vendors").delete().eq("id", id).select("id"),
    "delete this vendor",
  );
}

// --- Calendar events --------------------------------------------------------

export async function insertEvent(client: SupabaseClient, e: CalendarEvent): Promise<void> {
  check(await pm(client).from("calendar_events").insert(e), "create this event");
}

export async function patchEvent(
  client: SupabaseClient,
  id: string,
  patch: Partial<CalendarEvent>,
): Promise<void> {
  checkAffected(
    await pm(client).from("calendar_events").update(patch).eq("id", id).select("id"),
    "edit this event",
  );
}

export async function removeEvent(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("calendar_events").delete().eq("id", id).select("id"),
    "delete this event",
  );
}

// --- Subteams (admin-gated) -------------------------------------------------

export async function insertSubteam(client: SupabaseClient, st: Subteam): Promise<void> {
  check(await pm(client).from("subteams").insert(st), "create this subteam");
}

export async function patchSubteam(
  client: SupabaseClient,
  id: string,
  patch: Partial<Subteam>,
): Promise<void> {
  checkAffected(
    await pm(client).from("subteams").update(patch).eq("id", id).select("id"),
    "edit this subteam",
  );
}

export async function removeSubteam(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("subteams").delete().eq("id", id).select("id"),
    "delete this subteam",
  );
}

// --- Subsystems (admin-gated) -----------------------------------------------

export async function insertSubsystem(client: SupabaseClient, ss: Subsystem): Promise<void> {
  check(await pm(client).from("subsystems").insert(ss), "create this subsystem");
}

export async function patchSubsystem(
  client: SupabaseClient,
  id: string,
  patch: Partial<Subsystem>,
): Promise<void> {
  checkAffected(
    await pm(client).from("subsystems").update(patch).eq("id", id).select("id"),
    "edit this subsystem",
  );
}

export async function removeSubsystem(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("subsystems").delete().eq("id", id).select("id"),
    "delete this subsystem",
  );
}

// --- Build records ----------------------------------------------------------

// One row per task (task_id PK), so a partial change upserts on conflict.
export async function upsertBuildRecord(
  client: SupabaseClient,
  taskId: string,
  record: Partial<BuildRecord>,
): Promise<void> {
  checkAffected(
    await pm(client)
      .from("build_records")
      .upsert({ ...record, task_id: taskId }, { onConflict: "task_id" })
      .select("task_id"),
    "save this build record",
  );
}

// --- Projects (rename only — there is no client INSERT policy) ---------------

export async function patchProject(
  client: SupabaseClient,
  id: string,
  patch: Partial<Pick<Project, "name" | "description">>,
): Promise<void> {
  checkAffected(
    await pm(client).from("projects").update(patch).eq("id", id).select("id"),
    "rename this project",
  );
}
