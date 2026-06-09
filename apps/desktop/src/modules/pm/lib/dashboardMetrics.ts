// Pure, snapshot-only analytics for the Dashboard. Tasks carry no historical
// timestamps (no created/started/completed_at), so everything here is computed
// from the *current* state of the task set — distributions, counts, and ratios.
// These are the project-management signals you can get from a snapshot:
//   - Distribution / composition (group-by any task dimension)
//   - Throughput proxies & risk (completion %, overdue, blocked, WIP)
//   - Workload balance (load per owner, by count or estimated effort)
//   - Critical-path exposure (open work on the critical path)
// Anything time-series (burndown, cycle time, velocity) needs status-change
// history the model doesn't record yet — noted as a backend follow-up.

import type { TaskPriority, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
import {
  PRIORITY_COLOR,
  STATUS_FILL,
  STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  TASK_TYPE_LABEL,
  daysUntilDue,
  ownerColor,
} from "@helios/pm-ui";

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

// Type swatches — tasks have no assigned color by type, so give each a distinct,
// stable hue (kept clear of the status palette so a "by type" donut reads apart
// from a "by status" one).
export const TYPE_COLOR: Record<TaskType, string> = {
  part: "#60A5FA",
  drawing: "#A78BFA",
  simulation: "#22D3EE",
  assembly: "#34D399",
  analysis: "#FBBF24",
  test: "#F472B6",
  general: "#94A3B8",
  mfg_laser: "#FB923C",
  mfg_machine: "#F87171",
  mfg_weld: "#E879F9",
};

const FALLBACK_COLOR = "#6B7280";

// ---------------------------------------------------------------------------
// Group-by dimension — the heart of the configurable breakdown widget.
// ---------------------------------------------------------------------------

export type GroupKey =
  | "status"
  | "priority"
  | "type"
  | "owner"
  | "subteam"
  | "subsystem"
  | "mrl"
  | "critical_path";

export const GROUP_KEYS: readonly GroupKey[] = [
  "status",
  "priority",
  "type",
  "owner",
  "subteam",
  "subsystem",
  "mrl",
  "critical_path",
];

export const GROUP_LABEL: Record<GroupKey, string> = {
  status: "Status",
  priority: "Priority",
  type: "Type",
  owner: "Owner",
  subteam: "Subteam",
  subsystem: "Subsystem",
  mrl: "Readiness (MRL)",
  critical_path: "Critical path",
};

export interface Bucket {
  key: string;
  label: string;
  color: string;
  count: number;
}

// MRL 1..9 on a red→amber→green ramp so a readiness donut reads at a glance.
function mrlColor(mrl: number): string {
  const t = Math.min(1, Math.max(0, (mrl - 1) / 8));
  const hue = Math.round(t * 120); // 0=red, 120=green
  return `hsl(${hue}, 65%, 50%)`;
}

interface OneOf {
  key: string;
  label: string;
  color: string;
}

// Map a task to its bucket identity for the given dimension.
function bucketOf(task: TaskRow, key: GroupKey): OneOf {
  switch (key) {
    case "status":
      return { key: task.status, label: STATUS_LABEL[task.status], color: STATUS_FILL[task.status] };
    case "priority":
      return { key: task.priority, label: PRIORITY_LABEL[task.priority], color: PRIORITY_COLOR[task.priority] };
    case "type":
      return { key: task.type, label: TASK_TYPE_LABEL[task.type], color: TYPE_COLOR[task.type] };
    case "owner":
      return {
        key: task.owner_id ?? "__none__",
        label: task.owner?.name ?? "Unassigned",
        color: ownerColor(task.owner_id),
      };
    case "subteam":
      return {
        key: task.subteam.id,
        label: task.subteam.name,
        color: task.subteam.color ?? FALLBACK_COLOR,
      };
    case "subsystem":
      return {
        key: task.subsystem?.id ?? "__none__",
        label: task.subsystem?.name ?? "No subsystem",
        color: task.subsystem?.color ?? task.subteam.color ?? FALLBACK_COLOR,
      };
    case "mrl":
      return task.mrl == null
        ? { key: "__none__", label: "No MRL", color: FALLBACK_COLOR }
        : { key: `mrl-${task.mrl}`, label: `MRL ${task.mrl}`, color: mrlColor(task.mrl) };
    case "critical_path":
      return task.on_critical_path
        ? { key: "crit", label: "On critical path", color: "#FFC627" }
        : { key: "off", label: "Off critical path", color: FALLBACK_COLOR };
  }
}

// Canonical ordering for enumerated dimensions; dynamic dimensions fall back to
// count-desc (then label) for a tidy, stable legend.
const ENUM_ORDER: Partial<Record<GroupKey, readonly string[]>> = {
  status: TASK_STATUSES,
  priority: TASK_PRIORITIES,
  type: TASK_TYPES,
  mrl: ["mrl-1", "mrl-2", "mrl-3", "mrl-4", "mrl-5", "mrl-6", "mrl-7", "mrl-8", "mrl-9", "__none__"],
  critical_path: ["crit", "off"],
};

export function groupTasks(tasks: readonly TaskRow[], key: GroupKey): { buckets: Bucket[]; total: number } {
  const map = new Map<string, Bucket>();
  for (const t of tasks) {
    const b = bucketOf(t, key);
    const cur = map.get(b.key);
    if (cur) cur.count += 1;
    else map.set(b.key, { key: b.key, label: b.label, color: b.color, count: 1 });
  }
  const order = ENUM_ORDER[key];
  let buckets: Bucket[];
  if (order) {
    buckets = order
      .map((k) => map.get(k))
      .filter((b): b is Bucket => b !== undefined && b.count > 0);
  } else {
    buckets = [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
  return { buckets, total: tasks.length };
}

// ---------------------------------------------------------------------------
// Task sets — which tasks a distribution/workload widget counts.
// ---------------------------------------------------------------------------

export type TaskSet = "all" | "open" | "due_window";

export const TASK_SET_LABEL: Record<TaskSet, string> = {
  all: "All tasks",
  open: "Open (not done)",
  due_window: "Due within window",
};

export function filterSet(tasks: readonly TaskRow[], set: TaskSet, windowDays: number): TaskRow[] {
  switch (set) {
    case "all":
      return [...tasks];
    case "open":
      return tasks.filter((t) => t.status !== "done");
    case "due_window": {
      // Done is INCLUDED so a status breakdown of the window shows completed work
      // turning slices green; overdue (d < 0) is excluded — it has its own widgets.
      return tasks.filter((t) => {
        const d = daysUntilDue(t.due_date);
        return d !== null && d >= 0 && d <= windowDays;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Single-number KPIs.
// ---------------------------------------------------------------------------

export type MetricKey =
  | "completion"
  | "open_total"
  | "wip"
  | "blocked"
  | "overdue"
  | "due_soon"
  | "critical_open";

export const METRIC_KEYS: readonly MetricKey[] = [
  "completion",
  "open_total",
  "wip",
  "blocked",
  "overdue",
  "due_soon",
  "critical_open",
];

export const METRIC_LABEL: Record<MetricKey, string> = {
  completion: "Completion",
  open_total: "Open tasks",
  wip: "In progress",
  blocked: "Blocked",
  overdue: "Overdue",
  due_soon: "Due ≤ 7 days",
  critical_open: "Critical-path open",
};

export type MetricTone = "neutral" | "good" | "warn" | "bad";

export interface MetricResult {
  value: string;
  sub: string | null;
  ratio: number | null; // 0..1 → renders a progress bar when present
  tone: MetricTone;
}

const DUE_SOON_DAYS = 7;

export function computeMetric(tasks: readonly TaskRow[], key: MetricKey): MetricResult {
  const open = tasks.filter((t) => t.status !== "done");
  const countStatus = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  switch (key) {
    case "completion": {
      const done = tasks.filter((t) => t.status === "done").length;
      const total = tasks.length;
      const ratio = total ? done / total : 0;
      return {
        value: `${Math.round(ratio * 100)}%`,
        sub: `${done}/${total} done`,
        ratio,
        tone: ratio >= 0.75 ? "good" : ratio >= 0.4 ? "neutral" : "warn",
      };
    }
    case "open_total":
      return { value: String(open.length), sub: `${tasks.length} total`, ratio: null, tone: "neutral" };
    case "wip": {
      const n = countStatus("in_progress");
      return { value: String(n), sub: "active now", ratio: null, tone: "neutral" };
    }
    case "blocked": {
      const n = countStatus("blocked");
      return { value: String(n), sub: n ? "needs unblocking" : "none blocked", ratio: null, tone: n ? "bad" : "good" };
    }
    case "overdue": {
      const n = open.filter((t) => {
        const d = daysUntilDue(t.due_date);
        return d !== null && d < 0;
      }).length;
      return { value: String(n), sub: n ? "past due" : "on track", ratio: null, tone: n ? "bad" : "good" };
    }
    case "due_soon": {
      const n = open.filter((t) => {
        const d = daysUntilDue(t.due_date);
        return d !== null && d >= 0 && d <= DUE_SOON_DAYS;
      }).length;
      return { value: String(n), sub: `next ${DUE_SOON_DAYS} days`, ratio: null, tone: n ? "warn" : "good" };
    }
    case "critical_open": {
      const n = open.filter((t) => t.on_critical_path).length;
      return { value: String(n), sub: "on critical path", ratio: null, tone: n ? "warn" : "good" };
    }
  }
}

// ---------------------------------------------------------------------------
// Per-subteam comparison (all-subteams scope leaderboard).
// ---------------------------------------------------------------------------

export interface SubteamStat {
  id: string;
  name: string;
  code: string;
  color: string;
  total: number;
  done: number;
  open: number;
  overdue: number;
  completion: number; // 0..1
}

export function subteamStats(tasks: readonly TaskRow[]): SubteamStat[] {
  const map = new Map<string, SubteamStat>();
  for (const t of tasks) {
    const st = t.subteam;
    let row = map.get(st.id);
    if (!row) {
      row = {
        id: st.id,
        name: st.name,
        code: st.code,
        color: st.color ?? FALLBACK_COLOR,
        total: 0,
        done: 0,
        open: 0,
        overdue: 0,
        completion: 0,
      };
      map.set(st.id, row);
    }
    row.total += 1;
    if (t.status === "done") row.done += 1;
    else {
      row.open += 1;
      const d = daysUntilDue(t.due_date);
      if (d !== null && d < 0) row.overdue += 1;
    }
  }
  const rows = [...map.values()];
  for (const r of rows) r.completion = r.total ? r.done / r.total : 0;
  rows.sort((a, b) => b.completion - a.completion || b.total - a.total || a.name.localeCompare(b.name));
  return rows;
}

// ---------------------------------------------------------------------------
// Workload balance — load per owner, by task count or summed estimate-days.
// ---------------------------------------------------------------------------

export type WorkloadMeasure = "count" | "estimate";

export const WORKLOAD_MEASURE_LABEL: Record<WorkloadMeasure, string> = {
  count: "Task count",
  estimate: "Estimate-days",
};

export interface WorkloadRow {
  key: string;
  label: string;
  color: string;
  value: number;
}

export function workloadByOwner(
  tasks: readonly TaskRow[],
  measure: WorkloadMeasure,
): { rows: WorkloadRow[]; max: number } {
  const map = new Map<string, WorkloadRow>();
  for (const t of tasks) {
    const key = t.owner_id ?? "__none__";
    let row = map.get(key);
    if (!row) {
      row = { key, label: t.owner?.name ?? "Unassigned", color: ownerColor(t.owner_id), value: 0 };
      map.set(key, row);
    }
    row.value += measure === "estimate" ? t.estimate_days ?? 0 : 1;
  }
  const rows = [...map.values()]
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return { rows, max };
}
