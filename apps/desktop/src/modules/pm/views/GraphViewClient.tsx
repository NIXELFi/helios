"use client";

import type { Subteam, TaskColorProperty, TaskRow, TaskType } from "@helios/pm-ui";
import {
  STATUS_DOT,
  TASK_COLOR_PROPERTY_LABEL,
  TASK_TYPES,
  computeCriticalPath,
  resolveMarkerColors,
} from "@helios/pm-ui";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  PanOnScrollMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconEye, IconEyeOff, IconFilter, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { Select } from "@pm/components/ui/Select";
import { StatusLegend } from "@pm/components/StatusLegend";
import { ViewHeader } from "@pm/components/ViewHeader";
import {
  recallGraphSettings,
  rememberGraphSettings,
} from "@pm/lib/graphSettings";
import {
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

type GraphSort = "dependency_tree" | "criticality" | "upcoming" | "subteam_asc" | "subteam_desc";

const SORT_LABEL: Record<GraphSort, string> = {
  dependency_tree: "Dependency trees",
  criticality: "Most critical",
  upcoming: "Upcoming deadline",
  subteam_asc: "Subteam A→Z",
  subteam_desc: "Subteam Z→A",
};

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Comparator for top-to-bottom ordering within each dependency column.
function sortComparator(
  sort: GraphSort,
  critical: Set<string>,
): (a: TaskRow, b: TaskRow) => number {
  switch (sort) {
    case "dependency_tree":
      // The tree layout orders tasks within each tree by criticality; reuse that
      // here so the per-rank ordering is consistent.
      return (a, b) => criticalityScore(b, critical) - criticalityScore(a, critical);
    case "criticality":
      return (a, b) => criticalityScore(b, critical) - criticalityScore(a, critical);
    case "upcoming":
      return (a, b) =>
        (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31");
    case "subteam_asc":
      return (a, b) => a.subteam.name.localeCompare(b.subteam.name);
    case "subteam_desc":
      return (a, b) => b.subteam.name.localeCompare(a.subteam.name);
  }
}

function criticalityScore(t: TaskRow, critical: Set<string>): number {
  return (critical.has(t.id) ? 100 : 0) + (PRIORITY_RANK[t.priority] ?? 0);
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

interface TaskNodeData extends Record<string, unknown> {
  task: TaskRow;
  isCritical: boolean;
  inSelectedChain: boolean;
  dimmed: boolean;
  highlightCritical: boolean;
  relation: CrossTeamRelation;
  bgProperty: TaskColorProperty;
  outlineProperty: TaskColorProperty;
}

// Match the Gantt's translucent "glass" bar fill so the two views read the same.
const NODE_GLASS_ALPHA = 0.4;

type TaskNodeType = Node<TaskNodeData, "task">;
type FilterMode = "dim" | "hide";

interface GraphFilters {
  subteamIds: Set<string>;
  types: Set<TaskType>;
  mode: FilterMode;
}

const EMPTY_FILTERS: GraphFilters = {
  subteamIds: new Set(),
  types: new Set(),
  mode: "dim",
};

const nodeTypes = { task: TaskNode };

function TaskNode({ data }: NodeProps<TaskNodeType>) {
  const { task, isCritical, inSelectedChain, dimmed, highlightCritical, relation, bgProperty, outlineProperty } = data;
  const selectTask = usePmStore((s) => s.selectTask);
  const showCritical = highlightCritical && isCritical;
  const isExternal = relation !== "owned";

  // Match the Gantt: glass background colored by the chosen bg property, border
  // colored by the chosen outline property. Highlighted states (chain/critical)
  // still win on the border so the selected chain stays legible.
  const highlighted = inSelectedChain || showCritical;
  const borderClass = inSelectedChain
    ? "border-asu-gold ring-2 ring-asu-gold/40"
    : showCritical
      ? "border-asu-gold"
      : "";
  // Shared #23 rules (border-hide / dark-glass), consistent with Gantt/Calendar.
  const marker = resolveMarkerColors(task, bgProperty, outlineProperty, NODE_GLASS_ALPHA);

  return (
    <div
      className={
        "relative rounded border-2 px-3 py-2 backdrop-blur-sm transition-opacity " +
        (dimmed ? "opacity-15 " : isExternal ? "opacity-70 " : "opacity-100 ") +
        borderClass
      }
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        backgroundColor: marker.background,
        borderColor: highlighted ? undefined : marker.borderColor ?? "transparent",
        borderLeftWidth: 6,
        borderLeftColor: task.subteam.color ?? "#6B7280",
      }}
    >
      <Handle type="target" position={Position.Left}  style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      <div className="flex items-center gap-1.5">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[task.status] }} />
        <span
          className="truncate text-[10px] font-medium uppercase tracking-widest"
          style={{ color: task.subteam.color ?? "#9097A0" }}
        >
          {task.subteam.code}
        </span>
        <span className="ml-auto rounded bg-helios-base px-1.5 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
          {task.type}
        </span>
      </div>
      <p
        onClick={() => selectTask(task.id)}
        className={
          "mt-1 line-clamp-2 cursor-pointer overflow-hidden text-xs font-normal leading-snug hover:underline " +
          (isExternal ? "italic text-helios-text/80" : "text-helios-text")
        }
        title="Open task details"
      >
        {task.title}
      </p>
      <div className="mt-1 flex items-center justify-between text-[10px] text-helios-dim">
        <span>{task.owner?.name ?? "Unassigned"}</span>
        {task.due_date ? <span className="tabular-nums">{task.due_date}</span> : null}
      </div>
    </div>
  );
}

const handleStyle = {
  width: 8,
  height: 8,
  background: "#5A5F66",
  border: "1px solid #16171B",
};

const COL_GAP = NODE_WIDTH + 110;
const ROW_GAP = NODE_HEIGHT + 28;
// Gap between two adjacent column-mates that are NOT in the same dependency
// component — spread unrelated/isolated tasks out by ~2 task cards so they read
// as separate. Connected tasks stay at the normal ROW_GAP.
const UNRELATED_ROW_GAP = ROW_GAP * 2;

// In a SPECIFIC subteam's graph, cross-team prerequisite/dependent tasks are
// shown only up to this many dependency hops from the subteam's own tasks;
// anything farther removed is hidden.
const SUBTEAM_GRAPH_MAX_HOPS = 2;

// Subtasks are nested under their parent as an indented outline: each depth level
// shifts right by SUBTASK_INDENT, and stacked subtasks step down by SUBTASK_ROW_GAP.
const SUBTASK_INDENT = 48;
const SUBTASK_ROW_GAP = NODE_HEIGHT + 14;

const GRAPH_MIN_ZOOM = 0.15;
const GRAPH_MAX_ZOOM = 2.5;

// A task is a "convergence hub" once this many dependency chains feed into it
// (in-degree). The Dependency-trees layout treats the branches that converge on
// a hub as SEPARATE trees: their convergence edges are cut for grouping (so e.g.
// the whole Uprights chain becomes its own tree) and then drawn as long leader
// lines into the hub instead of merging everything into one jumbled component.
const HUB_IN_DEGREE = 3;

// IDs of tasks that ≥ HUB_IN_DEGREE dependencies converge into, within `tasks`.
function convergenceHubIds(
  tasks: ReadonlyArray<TaskRow>,
  edges: ReadonlyArray<{ predecessor_id: string; successor_id: string }>,
): Set<string> {
  const ids = new Set(tasks.map((t) => t.id));
  const indeg = new Map<string, number>();
  for (const e of edges) {
    if (ids.has(e.predecessor_id) && ids.has(e.successor_id)) {
      indeg.set(e.successor_id, (indeg.get(e.successor_id) ?? 0) + 1);
    }
  }
  const hubs = new Set<string>();
  for (const [id, n] of indeg) if (n >= HUB_IN_DEGREE) hubs.add(id);
  return hubs;
}

// Layered left-to-right layout. The x position of each task is its longest-path
// dependency depth (so prerequisites sit left of dependents). Within each depth
// column, tasks are ordered top-to-bottom by a barycenter sweep (seeded by the
// active sort comparator) so tasks feeding the same dependent stack together.
function layeredLayout(
  tasks: ReadonlyArray<TaskRow>,
  edges: ReadonlyArray<{ predecessor_id: string; successor_id: string }>,
  compare: (a: TaskRow, b: TaskRow) => number,
) {
  const ids = new Set(tasks.map((t) => t.id));
  const succs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const t of tasks) {
    succs.set(t.id, []);
    indeg.set(t.id, 0);
  }
  for (const e of edges) {
    if (ids.has(e.predecessor_id) && ids.has(e.successor_id)) {
      succs.get(e.predecessor_id)!.push(e.successor_id);
      indeg.set(e.successor_id, (indeg.get(e.successor_id) ?? 0) + 1);
    }
  }

  // Longest-path layering via Kahn topological sweep.
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const t of tasks) {
    if ((indeg.get(t.id) ?? 0) === 0) {
      rank.set(t.id, 0);
      queue.push(t.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = rank.get(id) ?? 0;
    for (const s of succs.get(id) ?? []) {
      rank.set(s, Math.max(rank.get(s) ?? 0, r + 1));
      indeg.set(s, (indeg.get(s) ?? 0) - 1);
      if ((indeg.get(s) ?? 0) === 0) queue.push(s);
    }
  }
  for (const t of tasks) if (!rank.has(t.id)) rank.set(t.id, 0); // cycle fallback

  const preds = new Map<string, string[]>();
  for (const t of tasks) preds.set(t.id, []);
  for (const e of edges) {
    if (ids.has(e.predecessor_id) && ids.has(e.successor_id)) {
      preds.get(e.successor_id)!.push(e.predecessor_id);
    }
  }

  const ranks = [...new Set(tasks.map((t) => rank.get(t.id)!))].sort((a, b) => a - b);
  const byRank = new Map<number, TaskRow[]>();
  for (const r of ranks) byRank.set(r, []);
  for (const t of tasks) byRank.get(rank.get(t.id)!)!.push(t);

  // Initial within-rank order = the active comparator.
  const orderOf = new Map<string, number>();
  for (const r of ranks) {
    const arr = byRank.get(r)!;
    arr.sort(compare);
    arr.forEach((t, i) => orderOf.set(t.id, i));
  }

  // Barycenter sweeps: reorder each column by the mean position of the nodes it
  // connects to. The UP sweep (order by SUCCESSORS) stacks tasks that feed the
  // SAME dependent together and lines them up with it — a single-successor task
  // takes exactly that dependent's position, so co-prerequisites become
  // contiguous. The DOWN sweep (order by PREDECESSORS) keeps things stable and
  // reduces crossings. The comparator breaks ties so order stays deterministic.
  const barycenter = (t: TaskRow, neighbors: string[]): number => {
    if (neighbors.length === 0) return orderOf.get(t.id)!;
    let sum = 0;
    for (const n of neighbors) sum += orderOf.get(n) ?? 0;
    return sum / neighbors.length;
  };
  const reorderBy = (arr: TaskRow[], pick: (t: TaskRow) => string[]) => {
    const key = new Map(arr.map((t) => [t.id, barycenter(t, pick(t))]));
    arr.sort((a, b) => key.get(a.id)! - key.get(b.id)! || compare(a, b));
    arr.forEach((t, i) => orderOf.set(t.id, i));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = ranks.length - 1; i >= 0; i--) reorderBy(byRank.get(ranks[i]!)!, (t) => succs.get(t.id) ?? []);
    for (let i = 0; i < ranks.length; i++) reorderBy(byRank.get(ranks[i]!)!, (t) => preds.get(t.id) ?? []);
  }

  // Weakly-connected component per task (union-find over the edges). Two adjacent
  // column-mates in DIFFERENT components are "not related by any dependency", so
  // they get the wider UNRELATED_ROW_GAP; same-component (same tree) stays tight.
  const parent = new Map<string, string>();
  for (const t of tasks) parent.set(t.id, t.id);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    while (parent.get(x)! !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  for (const e of edges) {
    if (!ids.has(e.predecessor_id) || !ids.has(e.successor_id)) continue;
    const a = find(e.predecessor_id);
    const b = find(e.successor_id);
    if (a !== b) parent.set(a, b);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const r of ranks) {
    const arr = byRank.get(r)!;
    let y = 0;
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i]!;
      if (i > 0) {
        const related = find(arr[i - 1]!.id) === find(t.id);
        y += related ? ROW_GAP : UNRELATED_ROW_GAP;
      }
      positions.set(t.id, { x: r * COL_GAP, y });
    }
  }
  return positions;
}

// "Dependency trees" layout: split the tasks into separate trees and stack them
// vertically so unrelated subsystems stop interleaving in the same columns (the
// "jumbled" complaint). Grouping uses connected components AFTER cutting the
// convergence edges that feed a hub (a task ≥ HUB_IN_DEGREE chains converge on),
// so e.g. the whole Uprights chain becomes its own tree instead of being pulled
// into the chassis tree just because it eventually feeds Outboard Corners
// Assembly. The cut edges still render (as dashed leader lines) between the
// separated trees. Each tree lays out left→right via layeredLayout (prerequisites
// left of dependents). Critical trees sort to the top; isolated singletons last.
function treeLayout(
  tasks: ReadonlyArray<TaskRow>,
  edges: ReadonlyArray<{ predecessor_id: string; successor_id: string }>,
  critical: Set<string>,
) {
  const ids = new Set(tasks.map((t) => t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Cut the edges that converge INTO a hub before grouping, so each branch that
  // feeds a hub falls into its own connected component (its own tree). The cut
  // edges still exist in the dependency set, so they render as long leader lines
  // between the separated trees.
  const hubs = convergenceHubIds(tasks, edges);

  // Bidirectional adjacency (minus cut convergence edges) → connected components.
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.id, []);
  for (const e of edges) {
    if (!ids.has(e.predecessor_id) || !ids.has(e.successor_id)) continue;
    if (hubs.has(e.successor_id)) continue; // cut: don't let branches merge at the hub
    adj.get(e.predecessor_id)!.push(e.successor_id);
    adj.get(e.successor_id)!.push(e.predecessor_id);
  }
  const seen = new Set<string>();
  const components: TaskRow[][] = [];
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    const comp: TaskRow[] = [];
    const stack = [t.id];
    seen.add(t.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = taskById.get(id);
      if (node) comp.push(node);
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp);
  }

  // Critical trees first, then larger trees, isolated singletons last.
  components.sort((a, b) => {
    const ac = a.some((t) => critical.has(t.id)) ? 1 : 0;
    const bc = b.some((t) => critical.has(t.id)) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    const aSingle = a.length === 1 ? 1 : 0;
    const bSingle = b.length === 1 ? 1 : 0;
    if (aSingle !== bSingle) return aSingle - bSingle;
    return b.length - a.length;
  });

  const cmp = sortComparator("criticality", critical);
  const COMPONENT_GAP = ROW_GAP * 1.5;

  // Lay out each tree internally (prerequisites left of dependents within the
  // tree) and measure its width.
  const subs = components.map((comp) => layeredLayout(comp, edges, cmp));
  const widths = subs.map((sub) => {
    let maxX = 0;
    for (const p of sub.values()) maxX = Math.max(maxX, p.x);
    return maxX + NODE_WIDTH;
  });

  // Build the component DAG from the cross-tree (cut) edges — every edge that
  // crosses trees is a hub leader line, predComp → succComp. Then x-offset each
  // tree by a longest-path sweep so a DEPENDENT tree always sits to the RIGHT of
  // every one of its prerequisite trees (the rule: prerequisites left of their
  // dependent, even across leader lines). Cycle-safe via an in-progress guard.
  const compOf = new Map<string, number>();
  components.forEach((comp, i) => {
    for (const t of comp) compOf.set(t.id, i);
  });
  const compPreds = components.map(() => new Set<number>());
  for (const e of edges) {
    const a = compOf.get(e.predecessor_id);
    const b = compOf.get(e.successor_id);
    if (a === undefined || b === undefined || a === b) continue;
    compPreds[b]!.add(a); // b depends on a → a must be left of b
  }
  const xOffset = new Array<number>(components.length).fill(-1);
  const inProgress = new Set<number>();
  const computeX = (c: number): number => {
    if (xOffset[c]! >= 0) return xOffset[c]!;
    if (inProgress.has(c)) return 0; // cycle fallback
    inProgress.add(c);
    let off = 0;
    for (const p of compPreds[c]!) {
      off = Math.max(off, computeX(p) + widths[p]! + COL_GAP);
    }
    inProgress.delete(c);
    xOffset[c] = off;
    return off;
  };
  for (let i = 0; i < components.length; i++) computeX(i);

  // --- Vertical placement -----------------------------------------------------
  // Group the feeder trees that converge on the SAME hub right next to each other
  // (same inter-tree spacing as everything else), then place the hub (the common
  // task) at the vertical MIDPOINT of the leader lines leaving the upper- and
  // lower-most feeder trees, so the leaders fan in symmetrically.
  const compHeight = subs.map((sub) => {
    let maxY = 0;
    for (const p of sub.values()) maxY = Math.max(maxY, p.y);
    return maxY + NODE_HEIGHT;
  });
  // For each hub component: the convergence task, and the feeder task that leads
  // into it from each feeder component (where its leader line departs).
  const hubTaskOf = new Array<string | null>(components.length).fill(null);
  const feederLeaf = components.map(() => new Map<number, string>());
  for (const e of edges) {
    const a = compOf.get(e.predecessor_id);
    const b = compOf.get(e.successor_id);
    if (a === undefined || b === undefined || a === b) continue;
    hubTaskOf[b] = e.successor_id;
    if (!feederLeaf[b]!.has(a)) feederLeaf[b]!.set(a, e.predecessor_id);
  }

  const yTop = new Array<number | null>(components.length).fill(null);
  let cursor = 0;
  const placeLinear = (c: number) => {
    if (yTop[c] !== null) return;
    yTop[c] = cursor;
    cursor += compHeight[c]! + COMPONENT_GAP;
  };

  for (let c = 0; c < components.length; c++) {
    if (yTop[c] !== null) continue;
    const feeders = [...compPreds[c]!];
    if (feeders.length < 2) {
      placeLinear(c);
      continue;
    }
    // Stack this hub's feeder trees consecutively.
    for (const f of feeders) placeLinear(f);
    // Midpoint of the leader lines leaving the upper- & lower-most feeders.
    let minY = Infinity;
    let maxY = -Infinity;
    for (const f of feeders) {
      const leaf = feederLeaf[c]!.get(f);
      const leafY =
        leaf && subs[f]!.has(leaf)
          ? yTop[f]! + subs[f]!.get(leaf)!.y + NODE_HEIGHT / 2
          : yTop[f]! + compHeight[f]! / 2;
      minY = Math.min(minY, leafY);
      maxY = Math.max(maxY, leafY);
    }
    const center = (minY + maxY) / 2;
    const hubTask = hubTaskOf[c];
    const hubLocalY = hubTask && subs[c]!.has(hubTask) ? subs[c]!.get(hubTask)!.y : 0;
    // Offset the hub component (it's shifted right in x, so overlapping the
    // feeders' y band is fine) so the common task lands on the midpoint.
    yTop[c] = center - hubLocalY - NODE_HEIGHT / 2;
  }
  for (let c = 0; c < components.length; c++) if (yTop[c] === null) placeLinear(c);

  const positions = new Map<string, { x: number; y: number }>();
  components.forEach((_comp, i) => {
    const sub = subs[i]!;
    for (const [id, p] of sub) {
      positions.set(id, { x: p.x + xOffset[i]!, y: p.y + yTop[i]! });
    }
  });
  return positions;
}

// Final safety pass: shift whole subtask-units downward until no two task cards
// overlap. A "unit" is a top-level task plus its entire nested subtask outline,
// moved together so the indentation stays intact. Only units whose x-ranges
// overlap interact, so separate columns are untouched.
function removeCardOverlaps(
  pos: Map<string, { x: number; y: number }>,
  tasks: ReadonlyArray<TaskRow>,
  displayed: Set<string>,
): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (id: string): string => {
    let cur = id;
    for (let g = 0; g < 1000; g++) {
      const pid = byId.get(cur)?.parent_task_id ?? null;
      if (pid && displayed.has(pid)) cur = pid;
      else break;
    }
    return cur;
  };
  const groups = new Map<string, string[]>();
  for (const t of tasks) {
    if (!pos.has(t.id)) continue;
    const r = rootOf(t.id);
    const arr = groups.get(r);
    if (arr) arr.push(t.id);
    else groups.set(r, [t.id]);
  }
  interface Unit {
    ids: string[];
    top: number;
    bottom: number;
    left: number;
    right: number;
  }
  const units: Unit[] = [];
  for (const ids of groups.values()) {
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const id of ids) {
      const p = pos.get(id)!;
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y + NODE_HEIGHT);
      left = Math.min(left, p.x);
      right = Math.max(right, p.x + NODE_WIDTH);
    }
    units.push({ ids, top, bottom, left, right });
  }
  units.sort((a, b) => a.top - b.top || a.left - b.left);
  const MARGIN = 16;
  const placed: Unit[] = [];
  for (const u of units) {
    let bumped = true;
    let guard = 0;
    while (bumped && guard++ < 4000) {
      bumped = false;
      for (const p of placed) {
        const xOverlap = u.left < p.right && p.left < u.right;
        const yOverlap = u.top < p.bottom + MARGIN && p.top < u.bottom + MARGIN;
        if (xOverlap && yOverlap) {
          const delta = p.bottom + MARGIN - u.top;
          if (delta > 0) {
            u.top += delta;
            u.bottom += delta;
            for (const id of u.ids) {
              const q = pos.get(id)!;
              pos.set(id, { x: q.x, y: q.y + delta });
            }
            bumped = true;
          }
        }
      }
    }
    placed.push(u);
  }
}

function ancestors(rootId: string, edges: ReadonlyArray<{ predecessor_id: string; successor_id: string }>) {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.successor_id === id && !out.has(e.predecessor_id)) {
        out.add(e.predecessor_id);
        stack.push(e.predecessor_id);
      }
    }
  }
  return out;
}

function descendants(rootId: string, edges: ReadonlyArray<{ predecessor_id: string; successor_id: string }>) {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.predecessor_id === id && !out.has(e.successor_id)) {
        out.add(e.successor_id);
        stack.push(e.successor_id);
      }
    }
  }
  return out;
}

// Transitive reduction for display: drop any direct edge u→v when v is already
// reachable from u through a longer path (u→…→v). The redundant "shortcut" trace
// is hidden so only the intermediary prerequisites connect, while the dependency
// data itself is untouched (v's detail sheet still lists u as a prerequisite).
function transitiveReduction<E extends { predecessor_id: string; successor_id: string }>(
  edges: ReadonlyArray<E>,
): E[] {
  const succ = new Map<string, string[]>();
  for (const e of edges) {
    const arr = succ.get(e.predecessor_id) ?? [];
    arr.push(e.successor_id);
    succ.set(e.predecessor_id, arr);
  }

  // Memoized descendant sets (DAG assumed; the empty set is cached before
  // recursing so a stray cycle terminates instead of looping forever).
  const cache = new Map<string, Set<string>>();
  function desc(id: string): Set<string> {
    const hit = cache.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    cache.set(id, out);
    for (const s of succ.get(id) ?? []) {
      if (!out.has(s)) {
        out.add(s);
        for (const x of desc(s)) out.add(x);
      }
    }
    return out;
  }

  return edges.filter((e) => {
    // Redundant if another successor of the same predecessor also reaches the
    // target (i.e. there is an alternate, longer path predecessor→…→target).
    for (const w of succ.get(e.predecessor_id) ?? []) {
      if (w !== e.successor_id && desc(w).has(e.successor_id)) return false;
    }
    return true;
  });
}

export interface GraphViewClientProps {
  teamSlug?: string | null;
}

export function GraphViewClient(props: GraphViewClientProps) {
  return (
    <ReactFlowProvider>
      <GraphInner teamSlug={props.teamSlug ?? null} />
    </ReactFlowProvider>
  );
}

function GraphInner({ teamSlug }: { teamSlug: string | null }) {
  const rf = useReactFlow();
  // Two-finger scroll pans (panOnScroll). Pinch / ctrl+scroll = ZOOM toward the
  // cursor, via a NON-passive, CAPTURE-phase wheel listener that runs before (and
  // stops) ReactFlow's pan handler.
  const zoomCleanup = useRef<(() => void) | null>(null);
  const zoomPaneRef = useCallback(
    (node: HTMLDivElement | null) => {
      zoomCleanup.current?.();
      zoomCleanup.current = null;
      if (!node) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return; // plain two-finger scroll → let ReactFlow pan
        e.preventDefault();
        e.stopPropagation();
        const { x, y, zoom } = rf.getViewport();
        const next = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, zoom * Math.exp(-e.deltaY * 0.0016)));
        if (next === zoom) return;
        const rect = node.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const fx = (px - x) / zoom;
        const fy = (py - y) / zoom;
        rf.setViewport({ x: px - fx * next, y: py - fy * next, zoom: next });
      };
      node.addEventListener("wheel", onWheel, { passive: false, capture: true });
      zoomCleanup.current = () =>
        node.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    },
    [rf],
  );
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const deps = usePmStore((s) => s.dependencies);
  const projectId = usePmStore((s) => s.projectId);
  const addTask = usePmStore((s) => s.addTask);
  const addDependency = usePmStore((s) => s.addDependency);
  const removeDependency = usePmStore((s) => s.removeDependency);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;

  const scopedRows = useMemo(() => {
    if (!currentTeam) {
      return tasks.map((task) => ({
        task,
        relation: "owned" as CrossTeamRelation,
        bridgeTaskIds: [] as string[],
      }));
    }
    // Subteam scope: owned tasks + cross-team prerequisites/dependents within
    // SUBTEAM_GRAPH_MAX_HOPS dependency hops. Tasks farther removed than that are
    // hidden so the graph stays focused on the subteam's immediate neighborhood.
    const teamId = currentTeam.id;
    const isMember = (t: TaskRow) =>
      (t.subteams ?? []).length > 0
        ? t.subteams.some((s) => s.id === teamId)
        : t.subteam_id === teamId;
    const ownedIds = new Set(tasks.filter(isMember).map((t) => t.id));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const preds = new Map<string, string[]>();
    const succs = new Map<string, string[]>();
    for (const t of tasks) {
      preds.set(t.id, []);
      succs.set(t.id, []);
    }
    for (const d of deps) {
      succs.get(d.predecessor_id)?.push(d.successor_id);
      preds.get(d.successor_id)?.push(d.predecessor_id);
    }
    const rel = new Map<string, CrossTeamRelation>();
    for (const id of ownedIds) rel.set(id, "owned");
    // Directed BFS outward from owned tasks, capped at SUBTEAM_GRAPH_MAX_HOPS.
    const expand = (adj: Map<string, string[]>, relation: CrossTeamRelation) => {
      const dist = new Map<string, number>();
      for (const id of ownedIds) dist.set(id, 0);
      let frontier = [...ownedIds];
      for (let hop = 1; hop <= SUBTEAM_GRAPH_MAX_HOPS; hop++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const n of adj.get(id) ?? []) {
            if (dist.has(n)) continue;
            dist.set(n, hop);
            if (!ownedIds.has(n) && !rel.has(n)) rel.set(n, relation);
            next.push(n);
          }
        }
        frontier = next;
      }
    };
    expand(preds, "prerequisite_of_team"); // upstream prerequisites
    expand(succs, "dependent_on_team"); // downstream dependents
    const out: { task: TaskRow; relation: CrossTeamRelation; bridgeTaskIds: string[] }[] = [];
    for (const [id, relation] of rel) {
      const t = byId.get(id);
      if (t) out.push({ task: t, relation, bridgeTaskIds: [] });
    }
    return out;
  }, [tasks, deps, currentTeam]);

  const visibleTasks = useMemo(() => scopedRows.map((r) => r.task), [scopedRows]);

  const relationByTaskId = useMemo(() => {
    const m = new Map<string, CrossTeamRelation>();
    for (const r of scopedRows) m.set(r.task.id, r.relation);
    return m;
  }, [scopedRows]);

  const [selected, setSelected] = useState<string | null>(null);
  const [highlightCritical, setHighlightCritical] = useState(false);
  // User-pinned positions, committed on drag STOP. react-flow owns the LIVE
  // drag (via useNodesState below); we persist only the final position here so
  // the node array isn't rebuilt mid-drag (which blanked the canvas).
  const [pinned, setPinned] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<TaskNodeType>([]);
  const [filters, setFilters] = useState<GraphFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<GraphSort>("dependency_tree");
  const [dialogOpen, setDialogOpen] = useState(false);

  // Color-by-property settings, persisted per-scope (mirrors the Gantt).
  const [colorSettings, setColorSettings] = useState(() => recallGraphSettings(teamSlug));
  const { bgProperty, outlineProperty } = colorSettings;
  useEffect(() => {
    rememberGraphSettings(teamSlug, colorSettings);
  }, [teamSlug, colorSettings]);

  // Apply filters: returns set of task IDs considered "in scope" by filters.
  // Empty filter selection means "all in scope".
  const filterInScope = useMemo(() => {
    const set = new Set<string>();
    for (const t of visibleTasks) {
      const teamMatch = filters.subteamIds.size === 0 || filters.subteamIds.has(t.subteam_id);
      const typeMatch = filters.types.size === 0 || filters.types.has(t.type);
      if (teamMatch && typeMatch) set.add(t.id);
    }
    return set;
  }, [visibleTasks, filters]);

  const anyFilterActive = filters.subteamIds.size > 0 || filters.types.size > 0;

  // Effective task list (after hide-mode filtering)
  const effectiveTasks = useMemo(() => {
    if (!anyFilterActive || filters.mode !== "hide") return visibleTasks;
    return visibleTasks.filter((t) => filterInScope.has(t.id));
  }, [visibleTasks, anyFilterActive, filters.mode, filterInScope]);

  const effectiveIds = useMemo(() => new Set(effectiveTasks.map((t) => t.id)), [effectiveTasks]);

  const effectiveDeps = useMemo(
    () => deps.filter((d) => effectiveIds.has(d.predecessor_id) && effectiveIds.has(d.successor_id)),
    [deps, effectiveIds],
  );

  // Edges to draw: the transitive reduction of the visible dependencies, so a
  // direct prerequisite that is also reachable through intermediaries doesn't
  // get a redundant shortcut trace. Layout and chain highlighting still use the
  // full `effectiveDeps`, so the omitted prerequisite stays on the chain.
  const reducedDeps = useMemo(() => transitiveReduction(effectiveDeps), [effectiveDeps]);

  // Critical path computed against full graph for correctness
  const critical = useMemo(() => computeCriticalPath(tasks, deps), [tasks, deps]);

  // Convergence hubs (≥ HUB_IN_DEGREE prerequisites). In the Dependency-trees
  // layout their incoming edges are the cross-tree "leader lines".
  const hubIds = useMemo(
    () => convergenceHubIds(effectiveTasks, effectiveDeps),
    [effectiveTasks, effectiveDeps],
  );

  const autoPositions = useMemo(() => {
    // Subtasks are laid out as an indented outline UNDER their parent rather than
    // by their own dependencies: lay out only the top-level (non-subtask) tasks
    // via the dependency layout, then stack each parent's subtask subtree below
    // it, indented one step per depth.
    const displayed = new Set(effectiveTasks.map((t) => t.id));
    const isSubtask = (t: TaskRow) =>
      t.parent_task_id != null && displayed.has(t.parent_task_id);
    const childrenOf = new Map<string, string[]>();
    for (const t of effectiveTasks) {
      if (isSubtask(t)) {
        const arr = childrenOf.get(t.parent_task_id!) ?? [];
        arr.push(t.id);
        childrenOf.set(t.parent_task_id!, arr);
      }
    }
    const topLevel = effectiveTasks.filter((t) => !isSubtask(t));
    const base =
      sort === "dependency_tree"
        ? treeLayout(topLevel, effectiveDeps, critical)
        : layeredLayout(topLevel, effectiveDeps, sortComparator(sort, critical));

    const pos = new Map(base);
    const seen = new Set<string>();
    const placeSubtree = (id: string, x: number, y: number): number => {
      pos.set(id, { x, y });
      seen.add(id);
      let cursor = y;
      for (const k of childrenOf.get(id) ?? []) {
        if (seen.has(k)) continue; // guard against malformed parent cycles
        cursor = placeSubtree(k, x + SUBTASK_INDENT, cursor + SUBTASK_ROW_GAP);
      }
      return cursor;
    };
    for (const t of topLevel) {
      const p = base.get(t.id);
      if (p && (childrenOf.get(t.id)?.length ?? 0) > 0) placeSubtree(t.id, p.x, p.y);
    }
    // Guarantee no two cards overlap.
    removeCardOverlaps(pos, effectiveTasks, displayed);
    return pos;
  }, [effectiveTasks, effectiveDeps, sort, critical]);

  useEffect(() => {
    const ids = new Set(effectiveTasks.map((t) => t.id));
    setPinned((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!ids.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [effectiveTasks]);

  const chain = useMemo(() => {
    if (!selected) return null;
    const a = ancestors(selected, effectiveDeps);
    const d = descendants(selected, effectiveDeps);
    a.add(selected);
    d.forEach((x) => a.add(x));
    return a;
  }, [selected, effectiveDeps]);

  const computedNodes: TaskNodeType[] = useMemo(
    () =>
      effectiveTasks.map((t) => {
        const pos = pinned.get(t.id) ?? autoPositions.get(t.id) ?? { x: 0, y: 0 };
        const inChain = chain === null ? false : chain.has(t.id);

        // A task is "dimmed" if:
        //   (a) a chain is selected and this task isn't on it, OR
        //   (b) filters are active in "dim" mode and this task is out of scope
        let dimmed = false;
        if (chain !== null && !inChain) dimmed = true;
        if (anyFilterActive && filters.mode === "dim" && !filterInScope.has(t.id)) dimmed = true;

        return {
          id: t.id,
          type: "task" as const,
          position: pos,
          data: {
            task: t,
            isCritical: critical.has(t.id),
            inSelectedChain: inChain,
            dimmed,
            highlightCritical,
            relation: relationByTaskId.get(t.id) ?? "owned",
            bgProperty,
            outlineProperty,
          },
          draggable: true,
          selectable: true,
        };
      }),
    [effectiveTasks, pinned, autoPositions, critical, chain, highlightCritical, relationByTaskId, anyFilterActive, filters.mode, filterInScope, bgProperty, outlineProperty],
  );

  // Push the derived nodes into react-flow's own node state. This runs only
  // when the derived inputs change (data / filter / sort / pinned) — NEVER
  // during a live drag — so react-flow's internal drag is never interrupted and
  // the canvas no longer blanks. We keep react-flow's measured fields and just
  // apply our authoritative position + data.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((nd) => [nd.id, nd]));
      return computedNodes.map((cn) => {
        const ex = prevById.get(cn.id);
        return ex ? { ...ex, position: cn.position, data: cn.data } : cn;
      });
    });
  }, [computedNodes, setRfNodes]);

  const edges: Edge[] = useMemo(
    () =>
      reducedDeps.map((d) => {
        const pred = effectiveTasks.find((t) => t.id === d.predecessor_id);
        const succ = effectiveTasks.find((t) => t.id === d.successor_id);
        const crossTeam = pred && succ && pred.subteam_id !== succ.subteam_id;
        const inChain = chain !== null && chain.has(d.predecessor_id) && chain.has(d.successor_id);
        const onCritical = critical.has(d.predecessor_id) && critical.has(d.successor_id);

        let dimmedByChain = chain !== null && !inChain;
        const dimmedByFilter =
          anyFilterActive && filters.mode === "dim" &&
          (!filterInScope.has(d.predecessor_id) || !filterInScope.has(d.successor_id));

        const dimmed = dimmedByChain || dimmedByFilter;

        let stroke = "#5A5F66";
        if (highlightCritical && onCritical) stroke = "#FFC627";
        else if (inChain) stroke = "#FFC627";
        else if (crossTeam) stroke = "#FB923C";

        const strokeWidth = inChain || (highlightCritical && onCritical) ? 2.5 : crossTeam ? 1.75 : 1.25;

        // In the Dependency-trees layout, an edge into a hub is a cross-tree
        // "leader line" connecting two separated trees — dash it so it reads as
        // a convergence link rather than an in-tree dependency.
        const isLeader = sort === "dependency_tree" && hubIds.has(d.successor_id);

        return {
          id: `${d.predecessor_id}-${d.successor_id}`,
          source: d.predecessor_id,
          target: d.successor_id,
          type: "smoothstep",
          label: d.lag_days > 0 ? `+${d.lag_days}d` : undefined,
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 3,
          labelBgStyle: { fill: "#16171B", stroke: "#2A2C32" },
          labelStyle: { fill: "#9097A0", fontSize: 9, fontWeight: 500 },
          style: {
            stroke,
            strokeWidth,
            opacity: dimmed ? 0.1 : 1,
            ...(isLeader ? { strokeDasharray: "7 4" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
          animated: inChain,
        };
      }),
    [reducedDeps, effectiveTasks, chain, critical, highlightCritical, anyFilterActive, filters.mode, filterInScope, sort, hubIds],
  );

  // Clamp panning to the bounding box of the laid-out tasks (plus padding) so
  // the user can't scroll far past the graph.
  //
  // IMPORTANT: derive the extent from the STABLE auto-layout positions, NOT from
  // the live `nodes` (whose positions change on every drag frame). Recomputing
  // translateExtent mid-drag makes react-flow re-clamp the viewport every frame,
  // which blanks the whole canvas while a node is being dragged. The generous
  // pad leaves plenty of room to reposition nodes by hand without hitting it.
  const translateExtent = useMemo<[[number, number], [number, number]]>(() => {
    const pts = [...autoPositions.values()];
    if (pts.length === 0) {
      return [
        [-1000, -1000],
        [1000, 1000],
      ];
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_WIDTH);
      maxY = Math.max(maxY, p.y + NODE_HEIGHT);
    }
    const PAD = 800;
    return [
      [minX - PAD, minY - PAD],
      [maxX + PAD, maxY + PAD],
    ];
  }, [autoPositions]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      addDependency({
        predecessor_id: c.source,
        successor_id: c.target,
        dep_type: "FS",
        lag_days: 0,
      });
    },
    [addDependency],
  );

  // react-flow owns the LIVE drag (via useNodesState's onNodesChange). We only
  // persist the final position when the drag ends, so `computedNodes` stays
  // stable during the drag.
  const onNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: TaskNodeType) => {
    setPinned((prev) => {
      const next = new Map(prev);
      next.set(node.id, { x: node.position.x, y: node.position.y });
      return next;
    });
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          const [predId, succId] = c.id.split("-");
          if (predId && succId) removeDependency(predId, succId);
        }
      }
    },
    [removeDependency],
  );

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Graph` : "Dependency graph"}
        description={
          selected
            ? "Click background to clear the highlighted chain"
            : "Two-finger swipe to pan · ctrl + scroll (or pinch) to zoom · drag between handles to author dependencies"
        }
        actions={
          // Wrap on narrow screens so the toolbar doesn't clip its right-edge buttons.
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Sort
              <Select
                size="sm"
                value={sort}
                ariaLabel="Sort"
                className="min-w-[130px]"
                onChange={(v) => {
                  setSort(v as GraphSort);
                  setPinned(new Map());
                }}
                options={(Object.keys(SORT_LABEL) as GraphSort[]).map((k) => ({
                  value: k,
                  label: SORT_LABEL[k],
                }))}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Fill
              <Select
                size="sm"
                value={bgProperty}
                ariaLabel="Node background color by"
                className="min-w-[110px]"
                onChange={(v) =>
                  setColorSettings((s) => ({ ...s, bgProperty: v as TaskColorProperty }))
                }
                options={(Object.keys(TASK_COLOR_PROPERTY_LABEL) as TaskColorProperty[]).map((k) => ({
                  value: k,
                  label: TASK_COLOR_PROPERTY_LABEL[k],
                }))}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-normal text-helios-dim">
              Outline
              <Select
                size="sm"
                value={outlineProperty}
                ariaLabel="Node outline color by"
                className="min-w-[110px]"
                onChange={(v) =>
                  setColorSettings((s) => ({ ...s, outlineProperty: v as TaskColorProperty }))
                }
                options={(Object.keys(TASK_COLOR_PROPERTY_LABEL) as TaskColorProperty[]).map((k) => ({
                  value: k,
                  label: TASK_COLOR_PROPERTY_LABEL[k],
                }))}
              />
            </label>
            <label className="inline-flex items-center gap-2 text-xs font-normal text-helios-dim">
              <input
                type="checkbox"
                checked={highlightCritical}
                onChange={(e) => setHighlightCritical(e.target.checked)}
                className="size-3 accent-asu-gold"
              />
              Highlight critical path
            </label>
            {pinned.size > 0 ? (
              <button
                type="button"
                onClick={() => setPinned(new Map())}
                className="inline-flex items-center gap-1 rounded border border-helios-line bg-transparent px-2 py-1 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
              >
                <IconRefresh size={12} strokeWidth={1.5} />
                Reset positions
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90"
            >
              <IconPlus size={16} strokeWidth={1.5} />
              New task
            </button>
          </div>
        }
      />

      <div ref={zoomPaneRef} className="relative" style={{ height: "calc(100vh - 73px)" }}>
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_e, n) => {
            // Plain node click only highlights the dependency chain. Opening the
            // detail sheet is reserved for clicking the task title (see TaskNode).
            setSelected(n.id);
          }}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          translateExtent={translateExtent}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={["Backspace", "Delete"]}
          // Two-finger scroll = pan; pinch / ctrl+scroll = zoom (handled manually
          // via zoomPaneRef, capture phase). ReactFlow's own scroll/pinch zoom is
          // off so it doesn't fight the pan or the manual zoom.
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          minZoom={GRAPH_MIN_ZOOM}
          maxZoom={GRAPH_MAX_ZOOM}
          panOnDrag
          style={{ backgroundColor: "#0E0E10" }}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Background color="#23252B" gap={20} />
          <Controls position="bottom-right" />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const d = (n.data as TaskNodeData | undefined)?.task;
              return d ? STATUS_DOT[d.status] : "#9097A0";
            }}
            maskColor="rgba(14,14,16,0.7)"
            style={{ backgroundColor: "#16171B", border: "1px solid #2A2C32" }}
          />

          <Panel position="top-left" className="!m-3">
            <FilterPanel
              filters={filters}
              subteams={subteams}
              onChange={setFilters}
              onClear={() => setFilters(EMPTY_FILTERS)}
            />
          </Panel>

          <Panel position="top-right" className="!m-3">
            <Legend />
          </Panel>
        </ReactFlow>
      </div>

      <CreateTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={(task) => {
          const teamPatched =
            currentTeam && task.subteam_id !== currentTeam.id
              ? { ...task, subteam_id: currentTeam.id, subteam: currentTeam, subsystem_id: null, subsystem: null }
              : task;
          addTask(teamPatched);
        }}
        projectId={projectId}
        subteams={subteams}
        subsystems={subsystems}
        users={users}
        defaultSubteamId={currentTeam?.id ?? null}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating filter panel (inside the graph viewport)
// ---------------------------------------------------------------------------

function FilterPanel({
  filters,
  subteams,
  onChange,
  onClear,
}: {
  filters: GraphFilters;
  subteams: ReadonlyArray<Subteam>;
  onChange: (next: GraphFilters) => void;
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const anyActive = filters.subteamIds.size > 0 || filters.types.size > 0;

  function toggleSubteam(id: string) {
    const next = new Set(filters.subteamIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...filters, subteamIds: next });
  }

  function toggleType(t: TaskType) {
    const next = new Set(filters.types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange({ ...filters, types: next });
  }

  return (
    <div className="w-64 rounded-md border border-helios-line bg-helios-panel/95 shadow-lg backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between border-b border-helios-line px-3 py-2 text-left"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-helios-text">
          <IconFilter size={12} strokeWidth={1.5} />
          Filters
          {anyActive ? (
            <span className="ml-1 rounded-full bg-asu-gold px-1.5 text-[9px] font-medium text-helios-base">
              {filters.subteamIds.size + filters.types.size}
            </span>
          ) : null}
        </span>
        <span className="text-[10px] text-helios-dim">{collapsed ? "Show" : "Hide"}</span>
      </button>

      {!collapsed ? (
        <div className="flex flex-col gap-3 px-3 py-3">
          <Section title="Subteams">
            <div className="flex flex-wrap gap-1">
              {subteams.map((s) => {
                const active = filters.subteamIds.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSubteam(s.id)}
                    className={
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                      (active
                        ? "border-helios-text/40 bg-helios-base text-helios-text"
                        : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                    }
                  >
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: s.color ?? "#6B7280" }} />
                    {s.code}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Types">
            <div className="flex flex-wrap gap-1">
              {TASK_TYPES.map((t) => {
                const active = filters.types.has(t);
                const isAssembly = t === "assembly";
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleType(t)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                      (active
                        ? isAssembly
                          ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
                          : "border-helios-text/40 bg-helios-base text-helios-text"
                        : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                    }
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Mode">
            <div className="inline-flex rounded-md border border-helios-line bg-helios-base p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => onChange({ ...filters, mode: "dim" })}
                className={
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors " +
                  (filters.mode === "dim"
                    ? "bg-helios-panel text-helios-text"
                    : "text-helios-dim hover:text-helios-text")
                }
              >
                <IconEyeOff size={11} strokeWidth={1.5} />
                Dim others
              </button>
              <button
                type="button"
                onClick={() => onChange({ ...filters, mode: "hide" })}
                className={
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors " +
                  (filters.mode === "hide"
                    ? "bg-helios-panel text-helios-text"
                    : "text-helios-dim hover:text-helios-text")
                }
              >
                <IconEye size={11} strokeWidth={1.5} />
                Hide others
              </button>
            </div>
          </Section>

          {anyActive ? (
            <button
              type="button"
              onClick={onClear}
              className="self-start rounded border border-helios-line bg-transparent px-2 py-0.5 text-[11px] font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">{title}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating legend (inside the graph viewport)
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <div className="flex w-48 flex-col gap-2 rounded-md border border-helios-line bg-helios-panel/95 px-3 py-2.5 text-[11px] font-normal text-helios-dim shadow-lg backdrop-blur-sm">
      <p className="text-[10px] font-medium uppercase tracking-widest text-helios-text">Legend</p>

      <div className="flex items-center gap-2">
        <span aria-hidden className="block h-px w-6 shrink-0 bg-helios-dim" />
        <span>Within-team edge</span>
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden className="block h-[1.5px] w-6 shrink-0 bg-orange-400" />
        <span>Cross-team edge</span>
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden className="block h-[2px] w-6 shrink-0 bg-asu-gold" />
        <span>Selected chain / critical</span>
      </div>

      <div className="my-1 border-t border-helios-line" />

      <div className="flex items-center gap-2">
        <span aria-hidden className="block size-3 shrink-0 rounded border-2 border-helios-line" style={{ borderLeftWidth: 4, borderLeftColor: "#A78BFA" }} />
        <span>Owned task</span>
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden className="block size-3 shrink-0 rounded border-2 border-helios-line opacity-70" style={{ borderLeftWidth: 4, borderLeftColor: "#FB923C" }} />
        <span>Cross-team task</span>
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden className="block size-3 shrink-0 rounded border-2 border-asu-gold" />
        <span>On critical path</span>
      </div>

      <div className="my-1 border-t border-helios-line" />

      <StatusLegend className="!text-[11px]" />
    </div>
  );
}
