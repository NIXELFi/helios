import type { SupabaseClient } from "@helios/auth";

/**
 * A cheap "did the workspace change?" signature for the PM module, used to gate
 * the heavy loadWorkspace re-hydrate. The old code blindly re-pulled the entire
 * workspace every 20s; this lets PmModule probe a few head/limit-1 requests
 * (~0 bytes) and only re-hydrate when the signature moves.
 *
 * It tracks TASKS — by far the highest-frequency collaborative entity, and the
 * only one with both an updated_at trigger and an append-only activity log:
 * - tasks          — count, so an added/removed task is detected
 * - tasksUpdatedAt — max(updated_at), so an in-place task edit is detected
 * - activity       — count of the (task-driven) activity feed
 * - taskOwners     — count, so a co-owner add/remove from another session shows
 * - taskLinks      — count, so a link add/remove from another session shows
 *
 * (task_owners / task_links have no updated_at + don't write the activity feed,
 * so their counts are the cheap change signal here.)
 *
 * The long tail (milestones/vendors/events/pages, which lack a cheap change
 * signal — milestones have no updated_at at all) is intentionally NOT tracked
 * here: PmModule keeps a window-focus full refresh and a slow full-rehydrate
 * backstop to cover those. So this cursor's job is only to make the common case
 * (task churn) feel live without the per-cycle full pull.
 */
export interface PmCursor {
  tasks: number;
  tasksUpdatedAt: string;
  activity: number;
  taskOwners: number;
  taskLinks: number;
}

/** Deterministic string form for cheap equality. */
export function pmCursorKey(c: PmCursor): string {
  return `${c.tasks}:${c.tasksUpdatedAt}:${c.activity}:${c.taskOwners}:${c.taskLinks}`;
}

/**
 * Did the workspace change since the last seen cursor? `prev === null` is the
 * first observation: a baseline, NOT a change.
 */
export function pmCursorChanged(prev: PmCursor | null, next: PmCursor): boolean {
  if (!prev) return false;
  return pmCursorKey(prev) !== pmCursorKey(next);
}

/**
 * Has this process seen the server answer "no such function" for the cursor
 * RPC? A database that predates 20260909100100 answers that on every probe, so
 * we latch it once and use the legacy five requests for the rest of the
 * session. Only a genuine missing-function signal sets it; a 500 must not
 * downgrade the client permanently.
 */
let rpcMissing = false;

/** PostgREST answers PGRST202 for an unknown RPC, Postgres 42883; match the
 *  wording too, because some call paths lose the code. */
function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (e?.code === "PGRST202" || e?.code === "42883") return true;
  return /could not find the function|does not exist/i.test(String(e?.message ?? ""));
}

const EMPTY_CURSOR: PmCursor = {
  tasks: 0,
  tasksUpdatedAt: "",
  activity: 0,
  taskOwners: 0,
  taskLinks: 0,
};

/**
 * Fetch the current PM cursor.
 *
 * Fast path: one `pm.workspace_cursor()` call. It is `security definer`, so
 * pm.can_read_pm is evaluated ONCE in its WHERE clause instead of once per row
 * in five RLS'd count queries — measured in prod at 13.3% of all database time
 * (a 797-row activity count took 72 ms). Falls back to the legacy five
 * requests on a database without the function; any other error throws so the
 * caller runs a full refresh rather than mistake it for "nothing changed".
 */
export async function fetchPmCursor(client: SupabaseClient): Promise<PmCursor> {
  if (!rpcMissing) {
    const { data, error } = await (client.schema("pm") as any).rpc("workspace_cursor");
    if (error) {
      if (!isMissingFunction(error)) {
        throw new Error(`pm cursor rpc: ${(error as { message?: string }).message ?? "failed"}`);
      }
      rpcMissing = true;
    } else {
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      // No row means the caller failed can_read_pm — the RPC's WHERE clause
      // filtered the whole result away. That is the same "nothing visible"
      // answer RLS gave the old counts (all zeros), and treating it as a
      // stable signature keeps a non-member from looping on full refreshes.
      if (!row) return { ...EMPTY_CURSOR };
      return {
        tasks: Number(row.tasks ?? 0),
        tasksUpdatedAt: (row.tasks_updated_at as string | null) ?? "",
        activity: Number(row.activity ?? 0),
        taskOwners: Number(row.task_owners ?? 0),
        taskLinks: Number(row.task_links ?? 0),
      };
    }
  }
  return fetchPmCursorLegacy(client);
}

/**
 * The pre-RPC probe: four head-only counts (tasks, activity, task_owners,
 * task_links) plus one limit-1 read of the newest task's updated_at. Kept as
 * the fallback for a database without 20260909100100. Throws if any sub-query
 * errors so the caller can fall back to a full refresh rather than mistake an
 * error for "nothing changed".
 */
export async function fetchPmCursorLegacy(client: SupabaseClient): Promise<PmCursor> {
  const sb = client.schema("pm");
  const head = { count: "exact", head: true } as const;

  const [tasksR, updR, activityR, ownersR, linksR] = await Promise.all([
    sb.from("tasks").select("id", head),
    sb.from("tasks").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    sb.from("activity").select("id", head),
    sb.from("task_owners").select("task_id", head),
    sb.from("task_links").select("id", head),
  ]);

  const fail = (r: { error: { message?: string } | null }, what: string) => {
    if (r.error) throw new Error(`pm cursor ${what}: ${r.error.message ?? "failed"}`);
  };
  fail(tasksR, "tasks count");
  fail(updR, "tasks updated_at");
  fail(activityR, "activity count");
  fail(ownersR, "task_owners count");
  fail(linksR, "task_links count");

  const updRow = ((updR.data ?? []) as Array<{ updated_at?: string | null }>)[0];

  return {
    tasks: tasksR.count ?? 0,
    tasksUpdatedAt: updRow?.updated_at ?? "",
    activity: activityR.count ?? 0,
    taskOwners: ownersR.count ?? 0,
    taskLinks: linksR.count ?? 0,
  };
}
