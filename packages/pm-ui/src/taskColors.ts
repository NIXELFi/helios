import { STATUS_FILL } from "./statusMeta";
import { CRITICALITY_BG } from "./taskState";
import type { TaskPriority, TaskRow } from "./types";

// Shared resolver for "color a task by one of its properties". Gantt (and any
// future view) picks a TaskColorProperty for a surface — background, outline —
// and asks colorForTask for the hex. Every property resolves through the same
// centralized color sources (statusMeta + taskState) so colors stay consistent.

export type TaskColorProperty = "status" | "priority" | "subteam" | "owner";

export const TASK_COLOR_PROPERTY_LABEL: Record<TaskColorProperty, string> = {
  status: "Status",
  priority: "Priority",
  subteam: "Subteam",
  owner: "Owner",
};

// Priority → hex, reusing the same saturated criticality fills as the table's
// criticality cell so "color by priority" matches the criticality column.
export const PRIORITY_COLOR: Record<TaskPriority, string> = {
  low: CRITICALITY_BG.low.hex,
  medium: CRITICALITY_BG.medium.hex,
  high: CRITICALITY_BG.high.hex,
  critical: CRITICALITY_BG.critical.hex,
};

// Users have no assigned color, so derive a stable one from the owner id. The
// same owner always maps to the same swatch within a session/across reloads.
const OWNER_PALETTE = [
  "#60A5FA", // blue
  "#34D399", // green
  "#FBBF24", // amber
  "#F87171", // red
  "#A78BFA", // violet
  "#22D3EE", // cyan
  "#F472B6", // pink
  "#A3E635", // lime
] as const;

const OWNER_NULL_COLOR = "#6B7280"; // neutral grey for "Unassigned"

export function ownerColor(ownerId: string | null): string {
  if (!ownerId) return OWNER_NULL_COLOR;
  // Simple deterministic string hash (djb2-ish) → palette index.
  let hash = 0;
  for (let i = 0; i < ownerId.length; i++) {
    hash = (hash * 31 + ownerId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % OWNER_PALETTE.length;
  return OWNER_PALETTE[idx]!;
}

const SUBTEAM_FALLBACK_COLOR = "#6B7280";

export function colorForTask(task: TaskRow, by: TaskColorProperty): string {
  switch (by) {
    case "status":
      return STATUS_FILL[task.status];
    case "priority":
      return PRIORITY_COLOR[task.priority];
    case "subteam":
      return task.subteam.color ?? SUBTEAM_FALLBACK_COLOR;
    case "owner":
      return ownerColor(task.owner_id);
  }
}

// Convert a #RRGGBB hex to an rgba() string at the given alpha. Accepts a
// leading "#"; falls back to the input if it isn't a 6-digit hex (so already
// rgba()/named colors pass through unharmed).
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
