import type { RawWorkspace } from "./data";

/**
 * Incremental apply of Supabase realtime payloads to the cached RawWorkspace —
 * so a teammate's edit costs a connected client zero or one request instead of
 * the full ~17-read `loadWorkspace` it used to trigger (load audit 2026-09-09
 * measured ≈1,650 of those full pulls a day in production).
 *
 * Pure and dependency-free (mirrors the Vault's apply-events.ts), so it is unit
 * testable and can never touch the network. Anything it cannot apply safely is
 * reported as `full: true` and the caller falls back to a full refresh; the
 * cursor probe and the backstop remain the safety net for missed events.
 *
 * The published `pm` tables have FULL replica identity, so an INSERT/UPDATE
 * payload carries the whole new row and a DELETE carries the old one. The three
 * task tables are the exception: a task's shape in the store includes three
 * PostgREST embeds (subteam, subsystem, task_subteams/task_owners), which a
 * change payload never carries — those ids are returned in `refetchTaskIds` for
 * the caller to re-read with `fetchTaskRowsByIds`.
 */

type Row = Record<string, unknown>;

export type PmEventType = "INSERT" | "UPDATE" | "DELETE";

export interface PmEvent {
  table: string;
  eventType: PmEventType;
  new: Row | null;
  old: Row | null;
}

export interface PmApplyResult {
  /** The updated cache — the SAME reference when nothing changed. */
  raw: RawWorkspace;
  /** Task ids whose row (or embeds) must be re-read before rebuilding. */
  refetchTaskIds: string[];
  /** True when an event could not be applied and a full pull is required. */
  full: boolean;
}

// The activity feed is fetched with `.limit(250)`; keep the cache the same size
// so an incrementally-updated feed matches what a full pull would have given.
const ACTIVITY_LIMIT = 250;

/** RawWorkspace fields that hold plain row lists we can patch by key. */
type ListKey =
  | "comments"
  | "links"
  | "milestones"
  | "events"
  | "subteams"
  | "depsRaw"
  | "hiddenSubteamsRaw";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const byId = (r: Row): string | null => str(r.id);
const pair = (a: unknown, b: unknown): string | null => {
  const x = str(a);
  const y = str(b);
  return x && y ? `${x}|${y}` : null;
};

/** Which list each published flat table lives in, and how one of its rows is keyed. */
const FLAT_TABLES: Record<string, { field: ListKey; key: (r: Row) => string | null }> = {
  task_comments: { field: "comments", key: byId },
  task_links: { field: "links", key: byId },
  milestones: { field: "milestones", key: byId },
  calendar_events: { field: "events", key: byId },
  subteams: { field: "subteams", key: byId },
  task_dependencies: {
    field: "depsRaw",
    key: (r) => pair(r.predecessor_id, r.successor_id),
  },
  project_hidden_subteams: {
    field: "hiddenSubteamsRaw",
    key: (r) => pair(r.project_id, r.subteam_id),
  },
};

// tasks / task_subteams / task_owners all change what ONE task row looks like.
const TASK_TABLES = new Set(["tasks", "task_subteams", "task_owners"]);

/**
 * Normalise a supabase-js `postgres_changes` payload into a PmEvent. Supabase
 * sends `{}` rather than null for the absent side of an event, and (on a table
 * without FULL replica identity) a DELETE's `old` carries only the key columns —
 * an empty object is treated as "no row", which routes to a full refresh.
 */
export function pmEventFrom(table: string, payload: unknown): PmEvent {
  const p = (payload ?? {}) as { eventType?: unknown; new?: unknown; old?: unknown };
  const type = p.eventType === "INSERT" || p.eventType === "DELETE" ? p.eventType : "UPDATE";
  return { table, eventType: type, new: rowOf(p.new), old: rowOf(p.old) };
}

function rowOf(v: unknown): Row | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return Object.keys(v as Row).length === 0 ? null : (v as Row);
}

/**
 * Apply a batch of realtime events to the cached raw rows.
 *
 * Returns the same `raw` reference when nothing changed, so a caller can skip
 * the rebuild+hydrate entirely for an event that only asks for a task re-read.
 */
export function applyPmEvents(raw: RawWorkspace, events: PmEvent[]): PmApplyResult {
  const refetchTaskIds: string[] = [];
  const bail: PmApplyResult = { raw, refetchTaskIds: [], full: true };

  let out = raw;
  let copied = false;
  const list = (key: ListKey): Row[] => out[key] as unknown as Row[];
  const putList = (key: ListKey, value: Row[]) => {
    if (value === (out[key] as unknown as Row[])) return;
    if (!copied) {
      out = { ...out };
      copied = true;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  };
  const putTasks = (value: Row[]) => {
    if (value === out.tasksRaw) return;
    if (!copied) {
      out = { ...out };
      copied = true;
    }
    out.tasksRaw = value;
  };
  const putActivity = (value: Row[]) => {
    if (value === (out.activity as unknown as Row[])) return;
    if (!copied) {
      out = { ...out };
      copied = true;
    }
    (out as unknown as Record<string, unknown>).activity = value;
  };

  for (const e of events) {
    if (TASK_TABLES.has(e.table)) {
      // A deleted task disappears now; there is nothing left to re-read.
      if (e.table === "tasks" && e.eventType === "DELETE") {
        const id = e.old ? byId(e.old) : null;
        if (!id) return bail;
        const rows = out.tasksRaw;
        const kept = rows.filter((t) => t.id !== id);
        if (kept.length !== rows.length) putTasks(kept);
        continue;
      }
      // Everything else (a task edit, an owner/subteam membership change) needs
      // the row re-read with its embeds — the payload alone can't rebuild it.
      const src = e.eventType === "DELETE" ? e.old : e.new;
      const id = src ? str(src.task_id) ?? str(src.id) : null;
      if (!id) return bail;
      if (!refetchTaskIds.includes(id)) refetchTaskIds.push(id);
      continue;
    }

    if (e.table === "activity") {
      const feed = out.activity as unknown as Row[];
      if (e.eventType === "DELETE") {
        const id = e.old ? byId(e.old) : null;
        if (!id) return bail;
        const kept = feed.filter((a) => a.id !== id);
        if (kept.length !== feed.length) putActivity(kept);
        continue;
      }
      const row = e.new;
      const id = row ? byId(row) : null;
      if (!row || !id) return bail;
      const i = feed.findIndex((a) => a.id === id);
      if (i !== -1) {
        // Already in the feed (a re-delivered insert, or an edit): replace in
        // place so the newest-first order the fetch established is preserved.
        const copy = feed.slice();
        copy[i] = row;
        putActivity(copy);
      } else if (e.eventType === "INSERT") {
        putActivity([row, ...feed].slice(0, ACTIVITY_LIMIT));
      }
      // An UPDATE of a row that fell off the end of the capped feed is a no-op:
      // prepending it would put an old entry at the top of a newest-first list.
      continue;
    }

    const spec = FLAT_TABLES[e.table];
    if (!spec) return bail; // an unpublished/unknown table — reconcile instead
    const rows = list(spec.field);
    if (e.eventType === "DELETE") {
      const key = e.old ? spec.key(e.old) : null;
      if (!key) return bail;
      const kept = rows.filter((r) => spec.key(r) !== key);
      if (kept.length !== rows.length) putList(spec.field, kept);
      continue;
    }
    const row = e.new;
    const key = row ? spec.key(row) : null;
    if (!row || !key) return bail;
    const i = rows.findIndex((r) => spec.key(r) === key);
    if (i === -1) {
      putList(spec.field, [...rows, row]);
    } else {
      const copy = rows.slice();
      copy[i] = row;
      putList(spec.field, copy);
    }
  }

  return { raw: out, refetchTaskIds, full: false };
}

/**
 * Replace the requested task rows with the freshly-read ones. An id that was
 * requested but did not come back is dropped: it was deleted, or RLS stopped
 * showing it to this user. Rows that came back but weren't cached are appended
 * (a task created by a teammate). Returns the same `raw` on a no-op.
 */
export function spliceTaskRows(
  raw: RawWorkspace,
  requestedIds: string[],
  rows: Array<Record<string, unknown>>,
): RawWorkspace {
  if (requestedIds.length === 0) return raw;
  const fresh = new Map<string, Row>();
  for (const r of rows) {
    const id = str(r.id);
    if (id) fresh.set(id, r);
  }
  const requested = new Set(requestedIds);
  const next: Row[] = [];
  let changed = false;
  for (const t of raw.tasksRaw) {
    const id = str(t.id);
    if (!id || !requested.has(id)) {
      next.push(t);
      continue;
    }
    const row = fresh.get(id);
    if (row) {
      next.push(row);
      fresh.delete(id);
      if (row !== t) changed = true;
    } else {
      changed = true; // gone
    }
  }
  for (const row of fresh.values()) {
    next.push(row);
    changed = true;
  }
  return changed ? { ...raw, tasksRaw: next } : raw;
}
