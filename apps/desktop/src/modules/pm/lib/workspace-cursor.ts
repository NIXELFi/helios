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
 * Fetch the current PM cursor. Four head-only counts (tasks, activity,
 * task_owners, task_links) plus one limit-1 read of the newest task's
 * updated_at. Throws if any sub-query errors so the caller can fall back to a
 * full refresh rather than mistake an error for "nothing changed".
 */
export async function fetchPmCursor(client: SupabaseClient): Promise<PmCursor> {
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
