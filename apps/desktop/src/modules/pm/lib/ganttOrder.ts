// Gantt row ordering: the sort modes for tasks within a subteam group, and the
// per-user manual order (2026-10-07 feature request — "unable to put them in a
// better order or manually move them"). The manual order is personal: it lives
// in localStorage per scope, like the rest of ganttSettings, so it needs no
// schema and never reorders anyone else's chart.

import type { Subsystem, TaskRow } from "@helios/pm-ui";
import { scopeKey } from "@pm/lib/nav";

export type GanttSort =
  | "manual"
  | "criticality"
  | "upcoming"
  | "alpha"
  | "subsystem"
  | "subteam_asc"
  | "subteam_desc";

export const SORT_LABEL: Record<GanttSort, string> = {
  manual: "Manual (my order)",
  criticality: "Most critical",
  upcoming: "Upcoming deadline",
  alpha: "Task A–Z",
  subsystem: "Subsystem",
  subteam_asc: "Subteam A–Z",
  subteam_desc: "Subteam Z–A",
};

export function isGanttSort(v: unknown): v is GanttSort {
  return typeof v === "string" && v in SORT_LABEL;
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function criticalityScore(t: TaskRow, critical: Set<string>): number {
  return (critical.has(t.id) ? 100 : 0) + (PRIORITY_RANK[t.priority] ?? 0);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Last-resort tie-break shared by every mode. Tasks arrive in whatever order
// Postgres returned them, so without it equal-scoring rows shuffled after edits.
function byTitle(a: TaskRow, b: TaskRow): number {
  return collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
}

/** Orders tasks within each subteam group (top to bottom). `manualOrder` is
 *  the user's saved id list; tasks not in it sort after the ordered ones. */
export function taskComparator(
  sort: GanttSort,
  critical: Set<string>,
  subsystems: readonly Subsystem[] = [],
  manualOrder: readonly string[] = [],
): (a: TaskRow, b: TaskRow) => number {
  switch (sort) {
    case "upcoming":
      return (a, b) =>
        (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31") || byTitle(a, b);
    case "alpha":
      return byTitle;
    case "subsystem": {
      const name = new Map(subsystems.map((s) => [s.id, s.name]));
      const label = (t: TaskRow) => (t.subsystem_id ? name.get(t.subsystem_id) : undefined);
      return (a, b) => {
        const la = label(a);
        const lb = label(b);
        // Tasks with no subsystem go last.
        if (la === undefined || lb === undefined) {
          if (la !== lb) return la === undefined ? 1 : -1;
          return byTitle(a, b);
        }
        return collator.compare(la, lb) || byTitle(a, b);
      };
    }
    case "manual": {
      const rank = new Map(manualOrder.map((id, i) => [id, i]));
      return (a, b) => {
        const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
        const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (ra !== rb) return ra < rb ? -1 : 1;
        return byTitle(a, b);
      };
    }
    default:
      return (a, b) => criticalityScore(b, critical) - criticalityScore(a, critical) || byTitle(a, b);
  }
}

/** Move one task up (-1) or down (+1) within its group. `groupIds` is the
 *  group as currently displayed; the group is written to the front of the
 *  returned list so every row in it gets an explicit rank (rows of other
 *  groups keep their relative order — groups never compare across). Returns
 *  `order` unchanged when the move would leave the group. */
export function moveInGroup(
  order: readonly string[],
  groupIds: readonly string[],
  taskId: string,
  delta: -1 | 1,
): string[] {
  const i = groupIds.indexOf(taskId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= groupIds.length) return [...order];
  const next = [...groupIds];
  next.splice(j, 0, ...next.splice(i, 1));
  const inGroup = new Set(next);
  return [...next, ...order.filter((id) => !inGroup.has(id))];
}

function storageKey(teamSlug: string | null): string {
  return `helios:gantt-order:${scopeKey(teamSlug)}`;
}

export function recallManualOrder(teamSlug: string | null): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(teamSlug));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // ignore storage/parse failures (private mode, quota, malformed JSON)
    return [];
  }
}

export function rememberManualOrder(teamSlug: string | null, order: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), JSON.stringify(order));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}
