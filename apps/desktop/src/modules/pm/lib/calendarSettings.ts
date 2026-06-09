// Per-scope, per-mode calendar color settings (#22) + the marker color resolver
// with the #23 special-cases. Mirrors ganttSettings.ts/graphSettings.ts but
// stores a body+border property choice for each calendar mode (week/month/year)
// so the user's choices persist independently per view.

import type { TaskBorderProperty, TaskColorProperty, TaskRow } from "@helios/pm-ui";
import { resolveMarkerColors } from "@helios/pm-ui";
import { scopeKey } from "@pm/lib/nav";

export type CalendarColorMode = "week" | "month" | "year";
export type CalendarBorderProperty = TaskBorderProperty;

export interface CalendarModeColors {
  body: TaskColorProperty;
  border: CalendarBorderProperty;
}
export type CalendarSettings = Record<CalendarColorMode, CalendarModeColors>;

export const CALENDAR_BODY_PROPS: readonly TaskColorProperty[] = [
  "status",
  "priority",
  "subteam",
  "owner",
];
export const CALENDAR_BORDER_PROPS: readonly CalendarBorderProperty[] = [
  "none",
  "status",
  "priority",
  "subteam",
  "owner",
];

// All-subteams default: body=status, border=subteam. Single subteam: border=none.
export function defaultCalendarSettings(allTeams: boolean): CalendarSettings {
  const one: CalendarModeColors = { body: "status", border: allTeams ? "subteam" : "none" };
  return { week: { ...one }, month: { ...one }, year: { ...one } };
}

function isBody(v: unknown): v is TaskColorProperty {
  return typeof v === "string" && (CALENDAR_BODY_PROPS as readonly string[]).includes(v);
}
function isBorder(v: unknown): v is CalendarBorderProperty {
  return typeof v === "string" && (CALENDAR_BORDER_PROPS as readonly string[]).includes(v);
}

function storageKey(teamSlug: string | null): string {
  return `helios:calendar:${scopeKey(teamSlug)}`;
}

export function recallCalendarSettings(
  teamSlug: string | null,
  allTeams: boolean,
): CalendarSettings {
  const fallback = defaultCalendarSettings(allTeams);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(teamSlug));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const obj = parsed as Record<string, unknown>;
    const pick = (mode: CalendarColorMode): CalendarModeColors => {
      const m = obj[mode];
      if (typeof m !== "object" || m === null) return fallback[mode];
      const mm = m as Record<string, unknown>;
      return {
        body: isBody(mm.body) ? mm.body : fallback[mode].body,
        border: isBorder(mm.border) ? mm.border : fallback[mode].border,
      };
    };
    return { week: pick("week"), month: pick("month"), year: pick("year") };
  } catch {
    return fallback;
  }
}

export function rememberCalendarSettings(
  teamSlug: string | null,
  settings: CalendarSettings,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), JSON.stringify(settings));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

const BODY_ALPHA = 0.45;

// Thin wrapper over the shared resolver (single source of the #23 rules) so the
// calendar's chips/squares stay consistent with the Gantt bars and Graph nodes.
export function calendarMarkerColors(
  task: TaskRow,
  body: TaskColorProperty,
  border: CalendarBorderProperty,
  alpha: number = BODY_ALPHA,
): { background: string; borderColor: string | null } {
  return resolveMarkerColors(task, body, border, alpha);
}
