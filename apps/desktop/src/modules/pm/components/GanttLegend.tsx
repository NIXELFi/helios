"use client";

import {
  PRIORITY_COLOR,
  STATUS_FILL,
  STATUS_LABEL,
  TASK_COLOR_PROPERTY_LABEL,
  TASK_PRIORITIES,
  TASK_STATUSES,
  hexToRgba,
  ownerColor,
  type Subteam,
  type TaskColorProperty,
  type TaskPriority,
  type TaskStatus,
  type User,
} from "@helios/pm-ui";

// Cap on how many subteam/owner swatches to enumerate before collapsing the
// remainder into a "+k more" note (status/priority always show their full set).
const SWATCH_CAP = 6;

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

interface Swatch {
  key: string;
  color: string;
  label: string;
}

// Build the list of swatches a given color property maps to, using the SAME
// palettes the bars resolve through (STATUS_FILL / PRIORITY_COLOR / subteam.color
// / ownerColor). subteam + owner are capped; the overflow is reported separately.
function swatchesFor(
  prop: TaskColorProperty,
  subteams: ReadonlyArray<Subteam>,
  users: ReadonlyArray<User>,
): { swatches: Swatch[]; more: number } {
  switch (prop) {
    case "status":
      return {
        swatches: (TASK_STATUSES as TaskStatus[]).map((s) => ({
          key: s,
          color: STATUS_FILL[s],
          label: STATUS_LABEL[s],
        })),
        more: 0,
      };
    case "priority":
      return {
        swatches: (TASK_PRIORITIES as TaskPriority[]).map((p) => ({
          key: p,
          color: PRIORITY_COLOR[p],
          label: PRIORITY_LABEL[p],
        })),
        more: 0,
      };
    case "subteam":
      return {
        swatches: subteams.slice(0, SWATCH_CAP).map((s) => ({
          key: s.id,
          color: s.color ?? "#6B7280",
          label: s.code,
        })),
        more: Math.max(0, subteams.length - SWATCH_CAP),
      };
    case "owner":
      return {
        swatches: [
          { key: "__none__", color: ownerColor(null), label: "Unassigned" },
          ...users.slice(0, SWATCH_CAP).map((u) => ({
            key: u.id,
            color: ownerColor(u.id),
            label: u.name,
          })),
        ],
        more: Math.max(0, users.length - SWATCH_CAP),
      };
  }
}

function LegendRow({
  role,
  prop,
  subteams,
  users,
}: {
  role: "Background" | "Outline";
  prop: TaskColorProperty;
  subteams: ReadonlyArray<Subteam>;
  users: ReadonlyArray<User>;
}) {
  const { swatches, more } = swatchesFor(prop, subteams, users);
  const isOutline = role === "Outline";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-helios-dim">
      <span className="font-medium text-helios-text/80">
        {role}: {TASK_COLOR_PROPERTY_LABEL[prop]}
      </span>
      {swatches.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={
              "inline-block size-2.5 rounded-sm " + (isOutline ? "border-2" : "")
            }
            style={
              isOutline
                ? { borderColor: s.color }
                : { backgroundColor: hexToRgba(s.color, 0.18) }
            }
          />
          {s.label}
        </span>
      ))}
      {more > 0 ? <span className="text-helios-dim/70">+{more} more</span> : null}
    </div>
  );
}

export interface GanttLegendProps {
  bgProperty: TaskColorProperty;
  outlineProperty: TaskColorProperty;
  subteams: ReadonlyArray<Subteam>;
  users: ReadonlyArray<User>;
}

// Dynamic Gantt legend: two rows mirroring the bar's background + outline color
// properties, each driven by the same palettes colorForTask resolves through so
// the legend always matches what the bars actually show.
export function GanttLegend({
  bgProperty,
  outlineProperty,
  subteams,
  users,
}: GanttLegendProps) {
  return (
    <div className="flex flex-col gap-1">
      <LegendRow role="Background" prop={bgProperty} subteams={subteams} users={users} />
      <LegendRow role="Outline" prop={outlineProperty} subteams={subteams} users={users} />
    </div>
  );
}
