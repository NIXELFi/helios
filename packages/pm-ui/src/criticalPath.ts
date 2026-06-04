import type { Task, TaskDependency } from "./types";

/** A task's duration for scheduling: its explicit estimate if set, otherwise the
 *  span of its scheduled window (due − start) when both dates exist, otherwise a
 *  unit fallback. Using real durations is what makes the critical path reflect
 *  *actual* time-driving tasks rather than just the longest hop-count chain. */
function durationOf(
  t: Pick<Task, "estimate_days" | "start_date" | "due_date">,
): number {
  if (t.estimate_days != null && t.estimate_days > 0) return t.estimate_days;
  if (t.start_date && t.due_date) {
    const span = (Date.parse(t.due_date) - Date.parse(t.start_date)) / 86_400_000;
    if (Number.isFinite(span) && span >= 1) return span;
  }
  return 1;
}

// Compute the set of task IDs that lie on the critical path of the project.
// Implementation: longest-path DP on the DAG. A task is critical when its
// earliest finish (forward pass) equals its latest finish (backward pass) AND it
// actually participates in a dependency chain. This client-side computation is
// the source of truth for the Gantt/Graph highlights and the Task Detail panel.
export function computeCriticalPath(
  tasks: ReadonlyArray<Pick<Task, "id" | "estimate_days" | "start_date" | "due_date">>,
  deps: ReadonlyArray<Pick<TaskDependency, "predecessor_id" | "successor_id">>,
): Set<string> {
  const ids = tasks.map((t) => t.id);
  const dur = new Map<string, number>(tasks.map((t) => [t.id, durationOf(t)]));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const d of deps) {
    if (!succ.has(d.predecessor_id) || !pred.has(d.successor_id)) continue;
    succ.get(d.predecessor_id)!.push(d.successor_id);
    pred.get(d.successor_id)!.push(d.predecessor_id);
    indeg.set(d.successor_id, (indeg.get(d.successor_id) ?? 0) + 1);
  }

  // Kahn's algorithm for topological order
  const queue: string[] = [];
  for (const [id, n] of indeg) if (n === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of succ.get(u) ?? []) {
      const next = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, next);
      if (next === 0) queue.push(v);
    }
  }

  // Cycle detected — bail to avoid wrong answers
  if (order.length !== ids.length) return new Set();

  // Forward pass: earliest finish
  const ef = new Map<string, number>();
  for (const u of order) {
    let maxPredEf = 0;
    for (const p of pred.get(u) ?? []) maxPredEf = Math.max(maxPredEf, ef.get(p) ?? 0);
    ef.set(u, maxPredEf + (dur.get(u) ?? 0));
  }

  const projectEnd = order.length === 0 ? 0 : Math.max(...ef.values());

  // Backward pass: latest finish
  const lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i]!;
    const succs = succ.get(u) ?? [];
    if (succs.length === 0) {
      lf.set(u, projectEnd);
    } else {
      let minSuccLs = Infinity;
      for (const s of succs) {
        const succLs = (lf.get(s) ?? projectEnd) - (dur.get(s) ?? 0);
        minSuccLs = Math.min(minSuccLs, succLs);
      }
      lf.set(u, minSuccLs);
    }
  }

  // Critical iff slack == 0 AND the task is actually wired into a dependency
  // chain. Excluding isolated tasks (no predecessors and no successors) is what
  // stops a project with no/sparse dependencies from marking EVERY task critical
  // — an isolated task trivially has zero slack but isn't on any path.
  const critical = new Set<string>();
  const EPS = 1e-6;
  for (const id of ids) {
    const isIsolated =
      (pred.get(id)?.length ?? 0) === 0 && (succ.get(id)?.length ?? 0) === 0;
    if (isIsolated) continue;
    const e = ef.get(id) ?? 0;
    const l = lf.get(id) ?? 0;
    if (Math.abs(e - l) < EPS) critical.add(id);
  }
  return critical;
}
