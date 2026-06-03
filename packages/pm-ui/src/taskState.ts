import type { Task, TaskPriority } from "./types";

export type TaskOutlineState =
  | "past_due"
  | "approaching"
  | "done"
  | "backlog"
  | "default";

export interface OutlineClasses {
  state: TaskOutlineState;
  borderColor: string;       // hex / css color
  borderClassName: string;   // tailwind class for border-color
  ringClassName?: string;    // optional ring class for prominence
}

const COLORS: Record<TaskOutlineState, { hex: string; tw: string }> = {
  past_due:    { hex: "#F87171", tw: "border-red-400" },
  approaching: { hex: "#FB923C", tw: "border-orange-400" },
  done:        { hex: "#34D399", tw: "border-emerald-400" },
  backlog:     { hex: "#A78BFA", tw: "border-violet-400" },
  default:     { hex: "#2A2C32", tw: "border-helios-line" },
};

export function taskOutlineState(
  task: Pick<Task, "status" | "due_date" | "estimate_days">,
  today: Date = new Date(),
): TaskOutlineState {
  if (task.status === "done") return "done";
  if (task.due_date) {
    const due = parseDate(task.due_date);
    if (due) {
      const ms = due.getTime() - today.setHours(0, 0, 0, 0);
      const days = Math.floor(ms / (1000 * 60 * 60 * 24));
      if (days < 0) return "past_due";
      // "Approaching" = days remaining is less than or equal to the
      // estimate plus a small grace window (3 days). If no estimate,
      // anything within 7 days is approaching.
      const cushion = (task.estimate_days ?? 0) + 3;
      const window = task.estimate_days != null ? cushion : 7;
      if (days <= window) return "approaching";
    }
  }
  if (task.status === "not_started") return "backlog";
  return "default";
}

export function taskOutline(
  task: Pick<Task, "status" | "due_date" | "estimate_days">,
  today: Date = new Date(),
): OutlineClasses {
  const state = taskOutlineState(task, today);
  const c = COLORS[state];
  return {
    state,
    borderColor: c.hex,
    borderClassName: c.tw,
    ringClassName: undefined,
  };
}

export function daysUntilDue(
  due_date: string | null,
  today: Date = new Date(),
): number | null {
  if (!due_date) return null;
  const d = parseDate(due_date);
  if (!d) return null;
  const ms = d.getTime() - today.setHours(0, 0, 0, 0);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function parseDate(iso: string): Date | null {
  // Expect YYYY-MM-DD; fall back to Date parse
  const [y, m, d] = iso.split("-").map(Number);
  if (y && m && d) return new Date(y, m - 1, d);
  const fallback = new Date(iso);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// Priority → row/card background tint + a foreground color guaranteed to
// have enough contrast against it. Foregrounds are picked from the dark
// palette (light text on dark tints) for our dark theme.
export interface PriorityTone {
  // Background tint applied as inline style for fine control over alpha
  background: string;
  // Foreground class for text inside this row/card
  textClassName: string;
  // Subtle left-border accent
  accent: string;
}

export const PRIORITY_TONE: Record<TaskPriority, PriorityTone> = {
  low:      { background: "transparent",          textClassName: "text-helios-text", accent: "#5A5F66" },
  medium:   { background: "rgba(96,165,250,0.06)", textClassName: "text-helios-text", accent: "#60A5FA" },
  high:     { background: "rgba(255,198,39,0.10)", textClassName: "text-helios-text", accent: "#FFC627" },
  critical: { background: "rgba(248,113,113,0.14)", textClassName: "text-helios-text", accent: "#F87171" },
};

// Solid criticality fill: a saturated background representing the priority
// state, paired with a black/white foreground chosen by relative luminance so
// the text always clears WCAG contrast against the chosen background. Used by
// table-like views that color the criticality cell.
export interface CriticalityFill {
  background: string;  // solid hex
  color: string;       // "#000000" | "#FFFFFF"
  label: string;
}

const CRITICALITY_BG: Record<TaskPriority, { hex: string; label: string }> = {
  low:      { hex: "#3A3F46", label: "Low" },
  medium:   { hex: "#2563EB", label: "Medium" },
  high:     { hex: "#FFC627", label: "High" },
  critical: { hex: "#DC2626", label: "Critical" },
};

// Pick black or white for maximum contrast against a hex background using the
// WCAG relative-luminance formula.
export function contrastText(hex: string): "#000000" | "#FFFFFF" {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "#000000" : "#FFFFFF";
}

export function criticalityFill(priority: TaskPriority): CriticalityFill {
  const c = CRITICALITY_BG[priority];
  return { background: c.hex, color: contrastText(c.hex), label: c.label };
}
