import type { TaskStatus } from "./types";

// Single source of truth for task-status presentation. The 5-status model
// (Not Started / In Progress / Needs Review / Blocked / Done) and its colors
// live here; every view/component imports these instead of copy-pasting maps.
//
// Friend spec: Not Started = clear/no-fill (neutral), In Progress = blue,
// Needs Review = yellow, Blocked = red, Done = green.

export const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  needs_review: "Needs Review",
  blocked: "Blocked",
  done: "Done",
};

// Dot/swatch hex — used for status dots in dropdowns, chips, calendar/graph
// markers, peek cards. not_started reads as a neutral grey (its "clear" intent
// is expressed by the absence of fill on cards/bars, not on the legend dot).
export const STATUS_DOT: Record<TaskStatus, string> = {
  not_started: "#9097A0",
  in_progress: "#60A5FA",
  needs_review: "#FFC627",
  blocked: "#F87171",
  done: "#34D399",
};

// Saturated fill hex — used where status fills a whole element (Gantt bars,
// Board accents). not_started uses a faint neutral so the element stays visible
// while still reading as "clear/no real status color".
export const STATUS_FILL: Record<TaskStatus, string> = {
  not_started: "#3A3F46",
  in_progress: "#2563EB",
  needs_review: "#FFC627",
  blocked: "#DC2626",
  done: "#16A34A",
};

// Tailwind background-class equivalent of STATUS_DOT, for surfaces that style
// the dot via className rather than inline style (e.g. the shared StatusBadge).
export const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  not_started: "bg-helios-dim",
  in_progress: "bg-blue-400",
  needs_review: "bg-asu-gold",
  blocked: "bg-red-400",
  done: "bg-emerald-400",
};
