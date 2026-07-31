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
  TaskLink,
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

// An UPDATE/DELETE/upsert that MUST touch an EXACT number of rows. PostgREST
// silently returns fewer rows (HTTP 200, error: null) when an RLS USING clause
// hides some of them from the write — so a denied edit looks like it saved and
// then "reverts" on the next reload (the bug behind report 1548ec9e). We chain
// `.select()` on every such write and compare the affected count against what
// the caller intended.
//
// `expected` defaults to 1 because almost every write here is scoped by a
// primary key (`.eq("id", …)`) and can therefore only ever touch one row. The
// bulk path passes `ids.length`: a `.in()` update spanning subteams where RLS
// permits only SOME rows comes back SHORT, not empty, and a `length === 0`
// check would wave it straight through — the UI would show every row updated
// and silently revert the denied ones on the next refresh. That is the exact
// class of bug the zero-row check was added for, so it has to catch the partial
// case too.
//
// The PARTIAL message deliberately reads differently from the total-denial one:
// the permitted rows DID commit server-side (PostgREST ran one statement, and
// the rows it was allowed to touch are saved), while the store rolls the whole
// optimistic change back on screen. The user has to know that the two no longer
// agree and that a reload is what shows the truth.
// A write that PARTIALLY committed: some rows saved server-side, the rest were
// hidden by RLS. Distinct from every other write failure because local state is
// now KNOWN to disagree with the server — a rollback alone leaves the user
// looking at a lie. `persist` detects this type and forces an authoritative
// workspace reload so the screen matches reality.
export class PartialWriteError extends Error {
  readonly needsReload = true;
  constructor(message: string) {
    super(message);
    this.name = "PartialWriteError";
  }
}

function checkAffected(
  res: { data: unknown[] | null; error: { message: string } | null },
  what: string,
  expected = 1,
): void {
  if (res.error) throw new Error(humanize(res.error.message, what));
  const affected = res.data?.length ?? 0;
  if (affected === 0) {
    throw new Error(`You don't have permission to ${what} (or it no longer exists).`);
  }
  if (affected !== expected) {
    throw new PartialWriteError(
      `Only ${affected} of ${expected} rows changed — you don't have permission to ` +
        `${what} for the rest. The allowed rows DID save, so we're reloading to show ` +
        `you what actually stuck.`,
    );
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
// returned set is SHORT (not just empty), which is why we hand checkAffected the
// intended count instead of letting it settle for "at least one row came back".
// A bulk edit spanning subteams where the user may only write some of them is
// the normal way to hit this.
export async function batchPatchTasks(
  client: SupabaseClient,
  ids: string[],
  patch: Partial<TaskRow>,
): Promise<void> {
  // Dedupe before counting: `WHERE id = ANY($ids)` returns one row per DISTINCT
  // id, so a caller that passed the same id twice would otherwise look like a
  // partial denial and trigger a spurious rollback + reload.
  const unique = [...new Set(ids)];
  checkAffected(
    await pm(client).from("tasks").update(taskColumns(patch)).in("id", unique).select("id"),
    "edit these tasks",
    unique.length,
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

// --- Task ↔ owner memberships -----------------------------------------------
// A task can have multiple owners. `pm.task_owners` is the join table;
// `pm.tasks.owner_id` stays the denormalized PRIMARY mirror, kept in sync by DB
// triggers (bidirectionally — a scalar owner_id write also updates the table).
// The client writes ADDITIONAL (non-primary) owners directly; promoting one to
// primary goes through the `set_task_primary_owner` RPC.

export async function insertTaskOwner(
  client: SupabaseClient,
  taskId: string,
  ownerId: string,
): Promise<void> {
  check(
    await pm(client)
      .from("task_owners")
      .insert({ task_id: taskId, owner_id: ownerId, is_primary: false }),
    "add this owner to the task",
  );
}

export async function removeTaskOwner(
  client: SupabaseClient,
  taskId: string,
  ownerId: string,
): Promise<void> {
  checkAffected(
    await pm(client)
      .from("task_owners")
      .delete()
      .eq("task_id", taskId)
      .eq("owner_id", ownerId)
      .select("task_id"),
    "remove this owner from the task",
  );
}

export async function setPrimaryOwner(
  client: SupabaseClient,
  taskId: string,
  ownerId: string,
): Promise<void> {
  check(
    await client
      .schema("pm")
      .rpc("set_task_primary_owner", { p_task_id: taskId, p_owner_id: ownerId }),
    "set primary owner",
  );
}

// --- Task links (hyperlinks) ------------------------------------------------

export async function insertTaskLink(client: SupabaseClient, link: TaskLink): Promise<void> {
  // Insert only client-controlled columns; let created_by (default auth.uid())
  // and created_at default server-side so a spoofed/stale author can't be set.
  check(
    await pm(client)
      .from("task_links")
      .insert({ id: link.id, task_id: link.task_id, url: link.url, label: link.label }),
    "add this link",
  );
}

export async function removeTaskLink(client: SupabaseClient, id: string): Promise<void> {
  checkAffected(
    await pm(client).from("task_links").delete().eq("id", id).select("id"),
    "remove this link",
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

// Set (or clear) a subteam's display icon. Unlike the name/code/color edits above
// (admin-RLS direct table writes), the icon is editable by any lead/exec/owner
// via this SECURITY DEFINER RPC, which re-checks the `pm.set_subteam_icon`
// capability held in ANY scope. `icon = null` clears the override so the subteam
// reverts to its auto-derived glyph.
export async function setSubteamIcon(
  client: SupabaseClient,
  id: string,
  icon: string | null,
): Promise<void> {
  check(
    await pm(client).rpc("set_subteam_icon", { p_id: id, p_icon: icon }),
    "change this subteam's icon",
  );
}

// --- Per-project subteam DISPLAY hides (sidebar nav list only) ---------------
// `pm.project_hidden_subteams` is RLS-locked for direct writes; the only write
// path is these SECURITY DEFINER RPCs, which re-check the org-scoped capability
// `pm.manage_project_subteams`. This is DISPLAY-ONLY: it never touches task
// assignment, membership (`task_subteams`/`project_subteams`), or permissions.

export async function hideProjectSubteam(
  client: SupabaseClient,
  projectId: string,
  subteamId: string,
): Promise<void> {
  check(
    await pm(client).rpc("hide_project_subteam", {
      p_project_id: projectId,
      p_subteam_id: subteamId,
    }),
    "hide this subteam for the project",
  );
}

export async function showProjectSubteam(
  client: SupabaseClient,
  projectId: string,
  subteamId: string,
): Promise<void> {
  check(
    await pm(client).rpc("show_project_subteam", {
      p_project_id: projectId,
      p_subteam_id: subteamId,
    }),
    "show this subteam for the project",
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

// --- Projects ----------------------------------------------------------------
// There is intentionally NO client INSERT policy on pm.projects (a direct insert
// can never pass the admin check — no membership exists yet for a brand-new
// project). Season creation goes through the SECURITY DEFINER `create_project`
// RPC, which atomically inserts the project AND the caller's admin membership.
// It is admin-gated server-side (raises 42501 if the caller isn't already an
// admin of some season). Renames DO have an UPDATE policy, hence patchProject.

// Create a new season (project) via the admin-only RPC. Returns the new project
// id. A season requires a year and a UNIQUE car code (e.g. "SDM28"); the name is
// the human label. Maps the two expected failures to teammate-readable messages.
export async function createProject(
  client: SupabaseClient,
  name: string,
  carYear: number,
  carCode: string,
): Promise<string> {
  const res = await client
    .schema("pm")
    .rpc("create_project", {
      p_name: name,
      p_car_year: carYear,
      p_car_code: carCode,
    });
  if (res.error) {
    const m = res.error.message.toLowerCase();
    // 42501: pm.create_project raises this when the caller isn't already an admin.
    if (
      res.error.code === "42501" ||
      m.includes("only an existing project admin") ||
      m.includes("permission denied") ||
      m.includes("row-level security")
    ) {
      throw new Error("Only an admin can create a season.");
    }
    // Unique violation on car_code (the only UNIQUE text column the RPC writes).
    if (
      res.error.code === "23505" ||
      m.includes("car_code") ||
      m.includes("duplicate key") ||
      m.includes("already exists")
    ) {
      throw new Error(`A season with car code ${carCode} already exists.`);
    }
    throw new Error(`Couldn't create this season: ${res.error.message}`);
  }
  const id = res.data as unknown;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Couldn't create this season: the server returned no id.");
  }
  return id;
}

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
