import { useCallback, useEffect, useRef, useState } from "react";
import { useThrottledFocus } from "./use-throttled-focus";

/** Shape of a `pm.tasks` row as the attention query selects it. */
export interface AttentionTaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  owner_id: string | null;
  task_owners?: Array<{ owner_id: string }> | null;
}

export interface PmAttention {
  /** Open tasks you own whose due date is today. */
  dueToday: number;
  /** Open tasks you own whose due date has passed. */
  overdue: number;
}

export const PM_ATTENTION_POLL_MS = 5 * 60_000;

/** Local calendar date as YYYY-MM-DD (task due dates are date-only). */
export function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Pure: fold the rows the query returned (everyone's tasks due ≤ today)
 *  into the caller's own due-today / overdue counts. Exported for tests. */
export function summarizeAttention(
  rows: ReadonlyArray<AttentionTaskRow>,
  userId: string,
  today = localDateKey(),
): PmAttention {
  let dueToday = 0;
  let overdue = 0;
  for (const t of rows) {
    if (!t.due_date || t.status === "done") continue;
    const mine = t.owner_id === userId || (t.task_owners ?? []).some((o) => o.owner_id === userId);
    if (!mine) continue;
    if (t.due_date === today) dueToday++;
    else if (t.due_date < today) overdue++;
  }
  return { dueToday, overdue };
}

/**
 * "What's due for me" for the title bar, independent of the PM module —
 * PM is mounted lazily, so its store may be empty for the whole session.
 * One bounded PostgREST read (open tasks due on or before today, then
 * filtered to yours client-side because ownership is split across
 * `owner_id` and `task_owners`), refreshed every 5 min, on window focus,
 * and on `pm:changed` (fired by the PM module after any write). Null until
 * the first result, or when there's no session / no PM access.
 */
export function usePmAttention(client: unknown, userId: string | null): PmAttention | null {
  const [value, setValue] = useState<PmAttention | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const c = client as {
      schema?: (s: string) => { from: (t: string) => any };
    } | null;
    if (!c || !userId || typeof c.schema !== "function") {
      setValue(null);
      return;
    }
    const mySeq = ++seq.current;
    try {
      const today = localDateKey();
      const { data, error } = await c
        .schema("pm")
        .from("tasks")
        .select("id,title,due_date,status,owner_id,task_owners(owner_id)")
        .neq("status", "done")
        .lte("due_date", today);
      if (error || !Array.isArray(data)) return;
      if (seq.current !== mySeq) return; // a newer refresh landed first
      setValue(summarizeAttention(data as AttentionTaskRow[], userId, today));
    } catch {
      /* transient — keep the last value */
    }
  }, [client, userId]);

  useEffect(() => {
    void refresh();
    if (!userId) return;
    const id = window.setInterval(() => void refresh(), PM_ATTENTION_POLL_MS);
    const onChanged = () => void refresh();
    window.addEventListener("pm:changed", onChanged);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pm:changed", onChanged);
    };
  }, [refresh, userId]);

  useThrottledFocus(() => void refresh(), 30_000, Boolean(userId));

  return value;
}
