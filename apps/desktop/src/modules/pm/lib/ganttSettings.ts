// Per-scope persisted Gantt view settings. Mirrors the localStorage pattern in
// nav.ts (storageKey + remember/recall with try/catch + SSR guard): each scope
// (the project, or a given subteam) remembers which task property colors the
// bar background and which colors the outline.

import type { TaskColorProperty } from "@helios/pm-ui";
import { scopeKey } from "@pm/lib/nav";

export interface GanttSettings {
  bgProperty: TaskColorProperty;
  outlineProperty: TaskColorProperty;
}

export const DEFAULT_GANTT_SETTINGS: GanttSettings = {
  bgProperty: "status",
  outlineProperty: "priority",
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

function storageKey(teamSlug: string | null): string {
  return `helios:gantt:${scopeKey(teamSlug)}`;
}

export function recallGanttSettings(teamSlug: string | null): GanttSettings {
  if (typeof window === "undefined") return DEFAULT_GANTT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(storageKey(teamSlug));
    if (!raw) return DEFAULT_GANTT_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_GANTT_SETTINGS;
    const obj = parsed as Record<string, unknown>;
    return {
      bgProperty: isColorProperty(obj.bgProperty)
        ? obj.bgProperty
        : DEFAULT_GANTT_SETTINGS.bgProperty,
      outlineProperty: isColorProperty(obj.outlineProperty)
        ? obj.outlineProperty
        : DEFAULT_GANTT_SETTINGS.outlineProperty,
    };
  } catch {
    // ignore storage/parse failures (private mode, quota, malformed JSON)
    return DEFAULT_GANTT_SETTINGS;
  }
}

export function rememberGanttSettings(teamSlug: string | null, settings: GanttSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), JSON.stringify(settings));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}
