// Per-scope persisted Dashboard configuration. Mirrors graphSettings.ts /
// ganttSettings.ts (and the nav.ts storageKey pattern): each scope (the project,
// or a given subteam) remembers a set of named *tabs*. A tab is an ordered list
// of widget *instances* — each instance has a kind (breakdown / metric / …),
// kind-specific config (e.g. a breakdown's group-by dimension and chart), and a
// size. The same kind can appear many times in a tab with different config (two
// breakdowns grouped by different dimensions, several KPI tiles, …).
//
// Per-user, localStorage only — like every other PM view setting. A layout
// shared across all members of a project still needs a project-level shared
// store (a backend follow-up) and is intentionally out of scope here.

import { scopeKey } from "@pm/lib/nav";
import {
  GROUP_KEYS,
  METRIC_KEYS,
  type GroupKey,
  type MetricKey,
  type TaskSet,
  type WorkloadMeasure,
} from "@pm/lib/dashboardMetrics";

// --- Sizing -----------------------------------------------------------------
// Widgets are scaled by column span on a 6-wide grid (single column on mobile).

export type WidgetSize = "sm" | "md" | "lg" | "xl";
export const WIDGET_SIZES: readonly WidgetSize[] = ["sm", "md", "lg", "xl"];
export const SIZE_LABEL: Record<WidgetSize, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
  xl: "Full",
};
// Literal classes so the Tailwind content scanner picks them up.
export const SIZE_SPAN_CLASS: Record<WidgetSize, string> = {
  sm: "lg:col-span-2",
  md: "lg:col-span-3",
  lg: "lg:col-span-4",
  xl: "lg:col-span-6",
};

// --- Parameter bounds -------------------------------------------------------

export const DEADLINE_WINDOW_BOUNDS = { min: 1, max: 90 } as const;
export const EVENT_LIMIT_BOUNDS = { min: 1, max: 30 } as const;
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_EVENT_LIMIT = 8;

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// --- Widget instances (discriminated union) ---------------------------------

export type WidgetKind =
  | "breakdown"
  | "metric"
  | "deadlines"
  | "events"
  | "cross"
  | "workload"
  | "subteam_table";

export type ChartKind = "donut" | "bar";
export type CrossDirection = "prereq" | "dependent";

interface WidgetBase {
  id: string;
  size: WidgetSize;
}

export type Widget =
  | (WidgetBase & {
      kind: "breakdown";
      groupBy: GroupKey;
      chart: ChartKind;
      set: TaskSet;
      windowDays: number;
    })
  | (WidgetBase & { kind: "metric"; metric: MetricKey })
  | (WidgetBase & { kind: "deadlines"; windowDays: number })
  | (WidgetBase & { kind: "events"; limit: number })
  | (WidgetBase & { kind: "cross"; direction: CrossDirection })
  | (WidgetBase & { kind: "workload"; measure: WorkloadMeasure; set: TaskSet; windowDays: number })
  | (WidgetBase & { kind: "subteam_table" });

export interface WidgetKindMeta {
  kind: WidgetKind;
  label: string;
  blurb: string;
  // The scope where this widget is meaningful; "any" shows in both. Used to
  // shape the add-widget palette (the project root has no "other subteam", a
  // single subteam has no cross-subteam comparison).
  scope: "any" | "all_subteams" | "subteam";
}

export const WIDGET_KIND_META: Record<WidgetKind, WidgetKindMeta> = {
  breakdown: {
    kind: "breakdown",
    label: "Breakdown",
    blurb: "Distribution of tasks by any dimension (status, priority, owner …).",
    scope: "any",
  },
  metric: {
    kind: "metric",
    label: "KPI tile",
    blurb: "A single headline number — completion, overdue, WIP, blocked …",
    scope: "any",
  },
  deadlines: {
    kind: "deadlines",
    label: "Deadlines table",
    blurb: "Not-done tasks due within the window or overdue.",
    scope: "any",
  },
  events: {
    kind: "events",
    label: "Upcoming events",
    blurb: "Next calendar events with countdowns.",
    scope: "any",
  },
  workload: {
    kind: "workload",
    label: "Workload by owner",
    blurb: "Load per person, by task count or estimated effort.",
    scope: "any",
  },
  cross: {
    kind: "cross",
    label: "Cross-subteam links",
    blurb: "Prerequisites from / dependents on other subteams.",
    scope: "subteam",
  },
  subteam_table: {
    kind: "subteam_table",
    label: "Subteam comparison",
    blurb: "Per-subteam totals, completion, and overdue counts.",
    scope: "all_subteams",
  },
};

// Whether a widget kind is offered / rendered in the current scope.
export function kindAvailable(kind: WidgetKind, isSubteamScope: boolean): boolean {
  const scope = WIDGET_KIND_META[kind].scope;
  if (scope === "any") return true;
  return scope === "subteam" ? isSubteamScope : !isSubteamScope;
}

let idSeq = 0;
function genId(prefix = "w"): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

export function makeWidget(kind: WidgetKind): Widget {
  const id = genId();
  switch (kind) {
    case "breakdown":
      return { id, kind, size: "md", groupBy: "status", chart: "donut", set: "due_window", windowDays: DEFAULT_WINDOW_DAYS };
    case "metric":
      return { id, kind, size: "sm", metric: "completion" };
    case "deadlines":
      return { id, kind, size: "xl", windowDays: DEFAULT_WINDOW_DAYS };
    case "events":
      return { id, kind, size: "md", limit: DEFAULT_EVENT_LIMIT };
    case "cross":
      return { id, kind, size: "md", direction: "prereq" };
    case "workload":
      return { id, kind, size: "lg", measure: "count", set: "open", windowDays: DEFAULT_WINDOW_DAYS };
    case "subteam_table":
      return { id, kind, size: "xl" };
  }
}

// --- Tabs / config model ----------------------------------------------------

export interface DashboardTab {
  id: string;
  name: string;
  widgets: Widget[];
}

export interface DashboardConfig {
  version: 2;
  tabs: DashboardTab[];
  activeTabId: string;
}

const CONFIG_VERSION = 2 as const;

// --- Scope-aware defaults (the sample tabs) ---------------------------------
// Typed builders keep the default layouts readable. Each returns a fresh widget.

function breakdown(o: {
  groupBy: GroupKey;
  chart?: ChartKind;
  set?: TaskSet;
  size?: WidgetSize;
}): Widget {
  return {
    id: genId(),
    kind: "breakdown",
    size: o.size ?? "md",
    groupBy: o.groupBy,
    chart: o.chart ?? "donut",
    set: o.set ?? "due_window",
    windowDays: DEFAULT_WINDOW_DAYS,
  };
}
function metric(m: MetricKey, size: WidgetSize = "sm"): Widget {
  return { id: genId(), kind: "metric", size, metric: m };
}
function deadlines(size: WidgetSize = "xl"): Widget {
  return { id: genId(), kind: "deadlines", size, windowDays: DEFAULT_WINDOW_DAYS };
}
function events(size: WidgetSize = "md"): Widget {
  return { id: genId(), kind: "events", size, limit: DEFAULT_EVENT_LIMIT };
}
function cross(direction: CrossDirection, size: WidgetSize = "md"): Widget {
  return { id: genId(), kind: "cross", size, direction };
}
function workload(measure: WorkloadMeasure = "count", size: WidgetSize = "lg"): Widget {
  return { id: genId(), kind: "workload", size, measure, set: "open", windowDays: DEFAULT_WINDOW_DAYS };
}
function subteamTable(size: WidgetSize = "xl"): Widget {
  return { id: genId(), kind: "subteam_table", size };
}

function tab(name: string, widgets: Widget[]): DashboardTab {
  return { id: genId("tab"), name, widgets };
}

function defaultTabs(isSubteamScope: boolean): DashboardTab[] {
  if (isSubteamScope) {
    return [
      tab("Overview", [
        metric("completion"),
        metric("open_total"),
        metric("overdue"),
        breakdown({ groupBy: "status", chart: "donut", set: "due_window" }),
        events(),
        deadlines(),
        cross("prereq"),
      ]),
      // Sample 1 — how is this subteam progressing and how is work distributed?
      tab("Subteam Productivity", [
        metric("completion"),
        metric("due_soon"),
        metric("wip"),
        breakdown({ groupBy: "subsystem", chart: "donut", set: "open" }),
        workload("count"),
        breakdown({ groupBy: "type", chart: "bar", set: "open" }),
      ]),
      // Sample 2 — what's blocking us and where's the schedule risk?
      tab("Dependencies & Risk", [
        metric("blocked"),
        metric("critical_open"),
        metric("overdue"),
        cross("prereq"),
        cross("dependent"),
        breakdown({ groupBy: "status", chart: "bar", set: "open" }),
        breakdown({ groupBy: "priority", chart: "donut", set: "open" }),
      ]),
    ];
  }
  return [
    tab("Overview", [
      metric("completion"),
      metric("open_total"),
      metric("overdue"),
      breakdown({ groupBy: "status", chart: "donut", set: "due_window" }),
      breakdown({ groupBy: "type", chart: "bar", set: "open" }),
      events(),
      deadlines(),
    ]),
    // Sample 1 — which subteams are ahead/behind and how is load shared?
    tab("Team Productivity", [
      metric("completion"),
      metric("due_soon"),
      metric("blocked"),
      subteamTable(),
      breakdown({ groupBy: "subteam", chart: "donut", set: "open" }),
      workload("count"),
    ]),
    // Sample 2 — overall workflow composition and bottlenecks.
    tab("Workflow Health", [
      metric("wip"),
      metric("blocked"),
      metric("critical_open"),
      breakdown({ groupBy: "status", chart: "bar", set: "open" }),
      breakdown({ groupBy: "priority", chart: "donut", set: "open" }),
      breakdown({ groupBy: "type", chart: "bar", set: "open", size: "lg" }),
      breakdown({ groupBy: "mrl", chart: "donut", set: "all" }),
    ]),
  ];
}

export function defaultDashboardConfig(isSubteamScope: boolean): DashboardConfig {
  const tabs = defaultTabs(isSubteamScope);
  return { version: CONFIG_VERSION, tabs, activeTabId: tabs[0]!.id };
}

// --- Persistence ------------------------------------------------------------

function storageKey(teamSlug: string | null): string {
  return `helios:dashboard:${scopeKey(teamSlug)}`;
}

const TASK_SETS: readonly TaskSet[] = ["all", "open", "due_window"];
const MEASURES: readonly WorkloadMeasure[] = ["count", "estimate"];

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// Re-derive a valid widget from raw localStorage: start from kind defaults (which
// mint a fresh id) then layer on validated saved fields. Unknown kind → dropped.
function normalizeWidget(raw: unknown): Widget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (!oneOf<WidgetKind>(kind, Object.keys(WIDGET_KIND_META) as WidgetKind[])) return null;
  const base = makeWidget(kind);
  if (typeof o.id === "string" && o.id) base.id = o.id;
  if (oneOf<WidgetSize>(o.size, WIDGET_SIZES)) base.size = o.size;
  switch (base.kind) {
    case "breakdown":
      if (oneOf<GroupKey>(o.groupBy, GROUP_KEYS)) base.groupBy = o.groupBy;
      if (oneOf<ChartKind>(o.chart, ["donut", "bar"])) base.chart = o.chart;
      if (oneOf<TaskSet>(o.set, TASK_SETS)) base.set = o.set;
      base.windowDays = clampInt(o.windowDays, DEADLINE_WINDOW_BOUNDS.min, DEADLINE_WINDOW_BOUNDS.max, base.windowDays);
      break;
    case "metric":
      if (oneOf<MetricKey>(o.metric, METRIC_KEYS)) base.metric = o.metric;
      break;
    case "deadlines":
      base.windowDays = clampInt(o.windowDays, DEADLINE_WINDOW_BOUNDS.min, DEADLINE_WINDOW_BOUNDS.max, base.windowDays);
      break;
    case "events":
      base.limit = clampInt(o.limit, EVENT_LIMIT_BOUNDS.min, EVENT_LIMIT_BOUNDS.max, base.limit);
      break;
    case "cross":
      if (oneOf<CrossDirection>(o.direction, ["prereq", "dependent"])) base.direction = o.direction;
      break;
    case "workload":
      if (oneOf<WorkloadMeasure>(o.measure, MEASURES)) base.measure = o.measure;
      if (oneOf<TaskSet>(o.set, TASK_SETS)) base.set = o.set;
      base.windowDays = clampInt(o.windowDays, DEADLINE_WINDOW_BOUNDS.min, DEADLINE_WINDOW_BOUNDS.max, base.windowDays);
      break;
    case "subteam_table":
      break;
  }
  return base;
}

function normalizeTab(raw: unknown): DashboardTab | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id : genId("tab");
  const name = typeof o.name === "string" && o.name.trim() ? o.name : "Untitled";
  const widgets = Array.isArray(o.widgets)
    ? o.widgets.map(normalizeWidget).filter((w): w is Widget => w !== null)
    : [];
  return { id, name, widgets };
}

function normalizeConfig(raw: unknown, isSubteamScope: boolean): DashboardConfig {
  if (typeof raw !== "object" || raw === null) return defaultDashboardConfig(isSubteamScope);
  const o = raw as Record<string, unknown>;
  // Version gate: older/foreign shapes are discarded wholesale rather than
  // half-migrated (this is a local-only preference, safe to reset).
  if (o.version !== CONFIG_VERSION) return defaultDashboardConfig(isSubteamScope);
  const tabs = Array.isArray(o.tabs)
    ? o.tabs.map(normalizeTab).filter((t): t is DashboardTab => t !== null)
    : [];
  const first = tabs[0];
  if (!first) return defaultDashboardConfig(isSubteamScope);
  const activeTabId =
    typeof o.activeTabId === "string" && tabs.some((t) => t.id === o.activeTabId)
      ? o.activeTabId
      : first.id;
  return { version: CONFIG_VERSION, tabs, activeTabId };
}

export function recallDashboardConfig(teamSlug: string | null, isSubteamScope: boolean): DashboardConfig {
  if (typeof window === "undefined") return defaultDashboardConfig(isSubteamScope);
  try {
    const raw = window.localStorage.getItem(storageKey(teamSlug));
    if (!raw) return defaultDashboardConfig(isSubteamScope);
    return normalizeConfig(JSON.parse(raw) as unknown, isSubteamScope);
  } catch {
    // ignore storage/parse failures (private mode, quota, malformed JSON)
    return defaultDashboardConfig(isSubteamScope);
  }
}

export function rememberDashboardConfig(teamSlug: string | null, config: DashboardConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), JSON.stringify(config));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

// --- Immutable update helpers ----------------------------------------------

export function activeTab(config: DashboardConfig): DashboardTab {
  return config.tabs.find((t) => t.id === config.activeTabId) ?? config.tabs[0]!;
}

export function setActiveTab(config: DashboardConfig, id: string): DashboardConfig {
  return config.tabs.some((t) => t.id === id) ? { ...config, activeTabId: id } : config;
}

export function addTab(config: DashboardConfig, name: string): DashboardConfig {
  const t = tab(name.trim() || `Tab ${config.tabs.length + 1}`, []);
  return { ...config, tabs: [...config.tabs, t], activeTabId: t.id };
}

export function deleteTab(config: DashboardConfig, id: string): DashboardConfig {
  if (config.tabs.length <= 1) return config; // never drop the last tab
  const tabs = config.tabs.filter((t) => t.id !== id);
  const activeTabId = config.activeTabId === id ? tabs[0]!.id : config.activeTabId;
  return { ...config, tabs, activeTabId };
}

export function renameTab(config: DashboardConfig, id: string, name: string): DashboardConfig {
  return {
    ...config,
    tabs: config.tabs.map((t) => (t.id === id ? { ...t, name: name.trim() || "Untitled" } : t)),
  };
}

function updateActiveTab(config: DashboardConfig, patch: (t: DashboardTab) => DashboardTab): DashboardConfig {
  const active = activeTab(config);
  const next = patch(active);
  // No-op patches (e.g. a reorder at the edge) return the same tab — keep the
  // same config reference so callers don't persist/re-render for nothing.
  if (next === active) return config;
  return { ...config, tabs: config.tabs.map((t) => (t.id === active.id ? next : t)) };
}

export function addWidget(config: DashboardConfig, kind: WidgetKind): DashboardConfig {
  return updateActiveTab(config, (t) => ({ ...t, widgets: [...t.widgets, makeWidget(kind)] }));
}

export function removeWidget(config: DashboardConfig, widgetId: string): DashboardConfig {
  return updateActiveTab(config, (t) => ({ ...t, widgets: t.widgets.filter((w) => w.id !== widgetId) }));
}

export function updateWidget(
  config: DashboardConfig,
  widgetId: string,
  patch: (w: Widget) => Widget,
): DashboardConfig {
  return updateActiveTab(config, (t) => ({
    ...t,
    widgets: t.widgets.map((w) => (w.id === widgetId ? patch(w) : w)),
  }));
}

// Move a widget one slot earlier (-1) or later (+1) within the active tab.
export function moveWidget(config: DashboardConfig, widgetId: string, dir: -1 | 1): DashboardConfig {
  return updateActiveTab(config, (t) => {
    const idx = t.widgets.findIndex((w) => w.id === widgetId);
    if (idx === -1) return t;
    const target = idx + dir;
    if (target < 0 || target >= t.widgets.length) return t;
    const widgets = t.widgets.slice();
    const a = widgets[idx];
    const b = widgets[target];
    if (!a || !b) return t;
    widgets[idx] = b;
    widgets[target] = a;
    return { ...t, widgets };
  });
}
