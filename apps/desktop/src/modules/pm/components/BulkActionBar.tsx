"use client";

import type { TaskPriority, TaskStatus, TaskType } from "@helios/pm-ui";
import {
  STATUS_DOT,
  STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  TASK_TYPE_LABEL,
  criticalityFill,
} from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { usePmStore } from "@pm/lib/pmStore";

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const STATUS_OPTIONS: SelectOption<TaskStatus>[] = TASK_STATUSES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
  swatch: STATUS_DOT[s],
}));

const PRIORITY_OPTIONS: SelectOption<TaskPriority>[] = TASK_PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p],
  fill: criticalityFill(p),
}));

const TYPE_OPTIONS: SelectOption<TaskType>[] = TASK_TYPES.map((t) => ({
  value: t,
  label: TASK_TYPE_LABEL[t],
}));

// An empty sentinel so each Select acts as a fire-once action menu: the trigger
// shows a placeholder ("Status…"), the user picks a value, we apply it, and the
// control immediately resets to the placeholder for the next action.
const ACTION = "" as const;

export interface BulkActionBarProps {
  // The current view's owned-and-selectable id set. The selection may carry
  // stale ids (e.g. after cross-team navigation) that are external/RLS-denied
  // in this scope; including them in an atomic .in() write would roll the whole
  // batch back. Intersecting against this set guarantees every write touches
  // only rows the active view actually owns.
  selectableIds?: ReadonlySet<string>;
}

export function BulkActionBar({ selectableIds }: BulkActionBarProps = {}) {
  const selectedTaskIds = usePmStore((s) => s.selectedTaskIds);
  const clearSelection = usePmStore((s) => s.clearSelection);
  const bulkUpdateTasks = usePmStore((s) => s.bulkUpdateTasks);
  const subteams = usePmStore((s) => s.subteams);
  const users = usePmStore((s) => s.users);

  // Effective ids = current selection ∩ this view's selectable set. When no set
  // is supplied (older callers / tests) fall back to the raw selection.
  const ids = selectableIds
    ? [...selectedTaskIds].filter((id) => selectableIds.has(id))
    : [...selectedTaskIds];

  const count = ids.length;
  if (count === 0) return null;

  const apply = (patch: Parameters<typeof bulkUpdateTasks>[1]) => {
    bulkUpdateTasks(ids, patch);
  };

  const commitDue = (value: string) => {
    apply({ due_date: value === "" ? null : value });
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
      <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-lg border border-helios-line bg-helios-panel/95 px-3 py-2 shadow-xl backdrop-blur">
        <span className="shrink-0 rounded bg-asu-gold px-2 py-0.5 text-xs font-semibold text-helios-base tabular-nums">
          {count} selected
        </span>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-helios-line" aria-hidden />

        <div className="w-32 shrink-0">
          <Select<TaskStatus | typeof ACTION>
            size="sm"
            value={ACTION}
            placeholder="Status…"
            ariaLabel="Set status for selected tasks"
            options={[{ value: ACTION, label: "Status…" }, ...STATUS_OPTIONS]}
            onChange={(v) => v !== ACTION && apply({ status: v })}
          />
        </div>

        <div className="w-32 shrink-0">
          <Select<TaskPriority | typeof ACTION>
            size="sm"
            value={ACTION}
            placeholder="Priority…"
            ariaLabel="Set priority for selected tasks"
            options={[{ value: ACTION, label: "Priority…" }, ...PRIORITY_OPTIONS]}
            onChange={(v) => v !== ACTION && apply({ priority: v })}
          />
        </div>

        <div className="w-32 shrink-0">
          <Select<TaskType | typeof ACTION>
            size="sm"
            value={ACTION}
            placeholder="Type…"
            ariaLabel="Set type for selected tasks"
            options={[{ value: ACTION, label: "Type…" }, ...TYPE_OPTIONS]}
            onChange={(v) => v !== ACTION && apply({ type: v })}
          />
        </div>

        <div className="w-36 shrink-0">
          <Select<string>
            size="sm"
            value={ACTION}
            placeholder="Owner…"
            ariaLabel="Set owner for selected tasks"
            options={[
              { value: ACTION, label: "Owner…" },
              { value: "__unassign__", label: "Unassigned" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
            onChange={(v) => {
              if (v === ACTION) return;
              apply({ owner_id: v === "__unassign__" ? null : v });
            }}
          />
        </div>

        <div className="w-36 shrink-0">
          <Select<string>
            size="sm"
            value={ACTION}
            placeholder="Subteam…"
            ariaLabel="Move selected tasks to subteam"
            options={[
              { value: ACTION, label: "Subteam…" },
              ...subteams.map((st) => ({
                value: st.id,
                label: st.name,
                swatch: st.color ?? "#6B7280",
              })),
            ]}
            onChange={(v) => v !== ACTION && apply({ subteam_id: v })}
          />
        </div>

        <label className="flex shrink-0 items-center gap-1.5 text-xs text-helios-dim">
          Due
          <input
            type="date"
            aria-label="Set due date for selected tasks"
            className="rounded border border-helios-line bg-helios-base px-1.5 py-1 text-xs text-helios-text focus:border-asu-gold focus:outline-none"
            // Native date inputs fire onChange on every intermediate/scrubbed
            // value (e.g. partial year). Committing on each would spam bulk
            // writes + undo entries — so commit only on blur or Enter, one
            // bulk write per chosen date.
            onBlur={(e) => commitDue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDue(e.currentTarget.value);
              }
            }}
          />
        </label>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-helios-line" aria-hidden />

        <button
          type="button"
          onClick={clearSelection}
          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-helios-dim hover:bg-helios-base hover:text-helios-text"
        >
          <IconX size={14} strokeWidth={1.5} />
          Clear
        </button>
      </div>
    </div>
  );
}
