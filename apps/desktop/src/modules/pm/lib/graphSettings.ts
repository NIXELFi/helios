// Per-scope persisted Dependency-graph view settings. Mirrors ganttSettings.ts
// (and the nav.ts storageKey pattern): each scope (the project, or a given
// subteam) remembers which task property colors the node background and which
// colors the node outline — matching the Gantt's color-by-property conventions.

import type { TaskColorProperty } from "@helios/pm-ui";
import { scopeKey } from "@pm/lib/nav";

// Graph layout mode. "lanes" = subteam/subsystem swimlanes with chronological
// columns (default); "clusters" = one rollup node per subteam (drill-down);
// "legacy" = the original dependency-trees layout.
export type GraphLayout = "lanes" | "clusters" | "legacy";
export const GRAPH_LAYOUTS: readonly GraphLayout[] = ["lanes", "clusters", "legacy"];
export const GRAPH_LAYOUT_LABEL: Record<GraphLayout, string> = {
  lanes: "Subteam Lanes",
  clusters: "Clusters",
  legacy: "Legacy Dependency",
};

export interface GraphSettings {
  bgProperty: TaskColorProperty;
  outlineProperty: TaskColorProperty;
  layout: GraphLayout;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  bgProperty: "status",
  outlineProperty: "priority",
  layout: "lanes",
};

const COLOR_PROPERTIES: readonly TaskColorProperty[] = [
  "status",
  "priority",
  "subteam",
  "owner",
];

function isColorProperty(v: unknown): v is TaskColorProperty {
  return typeof v === "string" && (COLOR_PROPERTIES as readonly string[]).includes(v);
}

function isLayout(v: unknown): v is GraphLayout {
  return typeof v === "string" && (GRAPH_LAYOUTS as readonly string[]).includes(v);
}

function storageKey(teamSlug: string | null): string {
  return `helios:graph:${scopeKey(teamSlug)}`;
}

export function recallGraphSettings(teamSlug: string | null): GraphSettings {
  if (typeof window === "undefined") return DEFAULT_GRAPH_SETTINGS;
  try {
    const raw = window.localStorage.getItem(storageKey(teamSlug));
    if (!raw) return DEFAULT_GRAPH_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_GRAPH_SETTINGS;
    const obj = parsed as Record<string, unknown>;
    return {
      bgProperty: isColorProperty(obj.bgProperty)
        ? obj.bgProperty
        : DEFAULT_GRAPH_SETTINGS.bgProperty,
      outlineProperty: isColorProperty(obj.outlineProperty)
        ? obj.outlineProperty
        : DEFAULT_GRAPH_SETTINGS.outlineProperty,
      layout: isLayout(obj.layout) ? obj.layout : DEFAULT_GRAPH_SETTINGS.layout,
    };
  } catch {
    // ignore storage/parse failures (private mode, quota, malformed JSON)
    return DEFAULT_GRAPH_SETTINGS;
  }
}

export function rememberGraphSettings(teamSlug: string | null, settings: GraphSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), JSON.stringify(settings));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}
