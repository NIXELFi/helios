import type { SupabaseClient } from "@helios/auth";
import type { TaskHistoryRow } from "@pm/lib/productivityMetrics";

// ---------------------------------------------------------------------------
// The one client entry point to pm.task_history (migration
// 20260914000000_pm_task_history_rpc.sql).
//
// Everything about who may see what lives on the server: the RPC checks project
// membership itself and nulls out actor_id / actor_name unless the caller holds
// pm.manage_dashboard in the requested scope. This wrapper adds no filtering of
// its own — it types the rows, coerces Postgres numerics, and translates the
// one error we expect to see in the wild ("function does not exist") into a
// first-class state instead of a crash.
// ---------------------------------------------------------------------------

export type { TaskHistoryRow };

/**
 * Why a fetch failed, in the two flavours the view renders differently.
 *
 *  - `unavailable`: the migration has not been applied to this server yet. Same
 *    fail-soft posture data.ts takes for pm.project_hidden_subteams — a missing
 *    migration must never look like a crash.
 *  - `error`: anything else (network, RLS, timeout). Retryable.
 */
export type TaskHistoryFailure = "unavailable" | "error";

export interface TaskHistoryResult {
  rows: TaskHistoryRow[];
  failure: TaskHistoryFailure | null;
  message: string | null;
}

export interface TaskHistoryQuery {
  projectId: string;
  /** Inclusive window start. */
  from: Date;
  /** Inclusive window end. */
  to: Date;
  /** Null = project-wide. */
  subteamId?: string | null;
}

// PostgREST reports a missing function as 42883 (undefined_function), and — when
// the schema cache has not seen it — as PGRST202. Either one means "this server
// does not have the migration", not "something broke".
function isMissingFunction(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42883" || err.code === "PGRST202") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find the function");
}

// Postgres numeric columns can serialize as strings; the metrics expect numbers.
const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function normalize(raw: Record<string, unknown>): TaskHistoryRow {
  return {
    activity_id: String(raw.activity_id ?? ""),
    event_time: String(raw.event_time ?? ""),
    action: (raw.action as TaskHistoryRow["action"]) ?? "created",
    task_id: String(raw.task_id ?? ""),
    task_title: str(raw.task_title),
    subteam_id: str(raw.subteam_id),
    subteam_name: str(raw.subteam_name),
    status_from: str(raw.status_from),
    status_to: str(raw.status_to),
    actor_id: str(raw.actor_id),
    actor_name: str(raw.actor_name),
    task_created_at: str(raw.task_created_at),
    due_date: str(raw.due_date),
    task_status_now: str(raw.task_status_now),
    estimate_days: num(raw.estimate_days),
    actual_days: num(raw.actual_days),
  };
}

/**
 * Pull the task history for a window. Never throws: a failure comes back as a
 * `failure` code with an empty row list, so the view can render its own state.
 */
export async function fetchTaskHistory(
  client: SupabaseClient,
  q: TaskHistoryQuery,
): Promise<TaskHistoryResult> {
  try {
    const res = await client.schema("pm").rpc("task_history", {
      p_project_id: q.projectId,
      p_from: q.from.toISOString(),
      p_to: q.to.toISOString(),
      p_subteam_id: q.subteamId ?? null,
    });
    if (res.error) {
      return {
        rows: [],
        failure: isMissingFunction(res.error) ? "unavailable" : "error",
        message: res.error.message,
      };
    }
    const raw = (res.data ?? []) as Array<Record<string, unknown>>;
    return { rows: raw.map(normalize), failure: null, message: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      rows: [],
      failure: isMissingFunction({ message }) ? "unavailable" : "error",
      message,
    };
  }
}
