/* Topological sort for overlay compute ordering.
 *
 * Each overlay can declare dependencies on other overlay ids (e.g. a
 * `stats` overlay reading R² from a `fit` overlay's artifact). We sort
 * so that every overlay's declared dependencies have computed before
 * it, then run a single compute pass.
 *
 * Cycles cannot legitimately arise — overlay configs only reference
 * upstream ids — but if one is constructed (corrupt config, future
 * overlay with a loop) we fall back to insertion order and warn rather
 * than throw or hang. */

export interface TopoNode<T> {
  /** Stable id used as both node identity and dependency target. */
  id: string;
  /** Ids this node depends on. Targets not in the input set are
   *  silently ignored — a stats overlay referencing a fit that was
   *  removed shouldn't break ordering of everything else. */
  dependsOn: ReadonlyArray<string>;
  /** Caller's payload. We return these in topo order. */
  value: T;
}

export interface TopoSortResult<T> {
  /** Nodes in dependency order: every node appears after its deps. */
  sorted: T[];
  /** True iff a cycle was detected and we fell back to insertion order. */
  hadCycle: boolean;
}

/* Kahn's algorithm. O(V + E). Stable: when multiple nodes have
 * indegree 0 we pop them in insertion order, so an overlay list with
 * no dependencies sorts identically to itself. */
export function topoSort<T>(nodes: ReadonlyArray<TopoNode<T>>): TopoSortResult<T> {
  const present = new Set<string>();
  for (const n of nodes) present.add(n.id);

  // adjacency: dep -> list of node ids that depend on it
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const byId = new Map<string, TopoNode<T>>();
  const order: string[] = []; // insertion order, for stable tie-breaking

  for (const n of nodes) {
    byId.set(n.id, n);
    order.push(n.id);
    indegree.set(n.id, 0);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!present.has(dep)) continue; // dangling reference, skip
      if (dep === n.id) continue;       // self-edge, skip (treat as no-op)
      let list = dependents.get(dep);
      if (!list) { list = []; dependents.set(dep, list); }
      list.push(n.id);
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
    }
  }

  // Seed the queue with indegree-0 nodes in insertion order.
  const queue: string[] = [];
  for (const id of order) if (indegree.get(id) === 0) queue.push(id);

  const sortedIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sortedIds.push(id);
    const outs = dependents.get(id);
    if (!outs) continue;
    for (const next of outs) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (sortedIds.length === nodes.length) {
    return { sorted: sortedIds.map((id) => byId.get(id)!.value), hadCycle: false };
  }

  // Cycle: fall back to original insertion order. Caller can still
  // render; dependent overlays just won't see their target's artifact
  // (same observable behavior as a dangling reference).
  return { sorted: nodes.map((n) => n.value), hadCycle: true };
}
