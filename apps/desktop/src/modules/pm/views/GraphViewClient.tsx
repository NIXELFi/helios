"use client";

import type { Subteam, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
import { TASK_TYPES, computeCriticalPath, taskOutline } from "@helios/pm-ui";
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
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconEye, IconEyeOff, IconFilter, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { Select } from "@pm/components/ui/Select";
import { StatusLegend } from "@pm/components/StatusLegend";
import { ViewHeader } from "@pm/components/ViewHeader";
import {
  scopeTasksToSubteam,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

type GraphSort = "criticality" | "upcoming" | "subteam_asc" | "subteam_desc";

const SORT_LABEL: Record<GraphSort, string> = {
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

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: "#9097A0",
  designing: "#60A5FA",
  manufacturing: "#FBBF24",
  testing: "#A78BFA",
  needs_review: "#FFC627",
  blocked: "#F87171",
  done: "#34D399",
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

interface TaskNodeData extends Record<string, unknown> {
  task: TaskRow;
  isCritical: boolean;
  inSelectedChain: boolean;
  dimmed: boolean;
  highlightCritical: boolean;
  relation: CrossTeamRelation;
}

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
  const { task, isCritical, inSelectedChain, dimmed, highlightCritical, relation } = data;
  const selectTask = usePmStore((s) => s.selectTask);
  const showCritical = highlightCritical && isCritical;
  const isExternal = relation !== "owned";
  const outline = taskOutline(task);

  // Highlighted states (chain / critical) win; otherwise the main border shows
  // the status-outline state (past due, due soon, done, backlog).
  const highlighted = inSelectedChain || showCritical;
  const borderClass = inSelectedChain
    ? "border-asu-gold ring-2 ring-asu-gold/40"
    : showCritical
      ? "border-asu-gold"
      : "";

  return (
    <div
      className={
        "relative rounded border-2 bg-helios-panel px-3 py-2 transition-opacity " +
        (dimmed ? "opacity-15 " : isExternal ? "opacity-70 " : "opacity-100 ") +
        borderClass
      }
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        borderColor: highlighted ? undefined : outline.borderColor,
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
          "mt-1 cursor-pointer text-xs font-normal leading-snug hover:underline " +
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

// Layered left-to-right layout. The x position of each task is its longest-path
// dependency depth (so prerequisites sit left of dependents). Within each depth
// column, tasks are ordered top-to-bottom by the active sort comparator.
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

  const byRank = new Map<number, TaskRow[]>();
  for (const t of tasks) {
    const r = rank.get(t.id)!;
    const arr = byRank.get(r) ?? [];
    arr.push(t);
    byRank.set(r, arr);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [r, arr] of byRank) {
    arr.sort(compare);
    arr.forEach((t, i) => {
      positions.set(t.id, { x: r * COL_GAP, y: i * ROW_GAP });
    });
  }
  return positions;
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
    return scopeTasksToSubteam(tasks, deps, currentTeam.id);
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
  const [sort, setSort] = useState<GraphSort>("criticality");
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const autoPositions = useMemo(
    () => layeredLayout(effectiveTasks, effectiveDeps, sortComparator(sort, critical)),
    [effectiveTasks, effectiveDeps, sort, critical],
  );

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
          },
          draggable: true,
          selectable: true,
        };
      }),
    [effectiveTasks, pinned, autoPositions, critical, chain, highlightCritical, relationByTaskId, anyFilterActive, filters.mode, filterInScope],
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
          style: { stroke, strokeWidth, opacity: dimmed ? 0.1 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
          animated: inChain,
        };
      }),
    [reducedDeps, effectiveTasks, chain, critical, highlightCritical, anyFilterActive, filters.mode, filterInScope],
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
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: TaskNodeType) => {
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
          <div className="flex items-center gap-3">
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

      <div className="relative" style={{ height: "calc(100vh - 73px)" }}>
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
          // Trackpad: two-finger drag = pan, pinch (ctrl+wheel) = zoom
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomOnScroll={false}
          zoomOnPinch
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
