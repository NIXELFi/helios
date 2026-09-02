"use client";

import type { TaskPriority, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
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
import { selectMyRole, usePmStore } from "@pm/lib/pmStore";
import { recallSharing, subsystemsForSubteam } from "@pm/lib/subsystemSharing";

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
  /** Subteam-grouped owner options from the view (see lib/ownerScope.ts) so
   *  "Set owner" ranks the same way every other picker does. Falls back to the
   *  flat directory. */
  ownerOptions?: ReadonlyArray<SelectOption<string>>;
}

export function BulkActionBar({ selectableIds, ownerOptions }: BulkActionBarProps = {}) {
  const selectedTaskIds = usePmStore((s) => s.selectedTaskIds);
  const clearSelection = usePmStore((s) => s.clearSelection);
  const bulkUpdateTasks = usePmStore((s) => s.bulkUpdateTasks);
  const subteams = usePmStore((s) => s.subteams);
  const users = usePmStore((s) => s.users);
  const tasks = usePmStore((s) => s.tasks);
  const subsystems = usePmStore((s) => s.subsystems);
  const activeProjectId = usePmStore((s) => s.activeProjectId);
  // Viewers can't write — disable every bulk action so a rejected write never
  // optimistically flips values that then snap back on auto-refresh.
  const isViewer = usePmStore(selectMyRole) === "viewer";

  // Effective ids = current selection ∩ this view's selectable set. When no set
  // is supplied (older callers / tests) fall back to the raw selection.
  const ids = selectableIds
    ? [...selectedTaskIds].filter((id) => selectableIds.has(id))
    : [...selectedTaskIds];

  const count = ids.length;
  if (count === 0) return null;

  // Subsystems valid for EVERY selected task. A subsystem belongs to a subteam,
  // so a bulk subsystem change can only offer ones relevant to all the selected
  // tasks' primary subteams (plus any shared to them) — the same rule as the
  // per-row table dropdowns. If the selection spans subteams with no common
  // subsystem, only "No subsystem" (clear) is offered.
  const sharing = recallSharing(activeProjectId);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const selectedTasks = ids.map((id) => taskById.get(id)).filter((t): t is TaskRow => !!t);
  const relevantSets = selectedTasks.map(
    (t) => new Set(subsystemsForSubteam(subsystems, t.subteam_id, sharing).map((s) => s.id)),
  );
  const commonIds =
    relevantSets.length === 0
      ? new Set<string>()
      : new Set([...relevantSets[0]!].filter((id) => relevantSets.every((set) => set.has(id))));
  const subsystemOptions: SelectOption<string>[] = subsystems
    .filter((s) => commonIds.has(s.id))
    .map((s) => ({ value: s.id, label: s.name, swatch: s.color ?? "#6B7280" }));

  const apply = (patch: Parameters<typeof bulkUpdateTasks>[1]) => {
    bulkUpdateTasks(ids, patch);
  };

  // Commit a chosen due date to every selected task. An EMPTY value is ignored:
  // merely focusing the date input and tabbing away (which fires onBlur with "")
  // must never wipe the due_date of every selected task (data-loss bug H-3).
  // Clearing a due date in bulk requires the explicit "Clear due" action below.
  const commitDue = (value: string) => {
    if (value === "") return;
    apply({ due_date: value });
  };

  const clearDue = () => {
    apply({ due_date: null });
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
            disabled={isViewer}
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
            disabled={isViewer}
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
            disabled={isViewer}
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
            disabled={isViewer}
            placeholder="Owner…"
            ariaLabel="Set owner for selected tasks"
            options={[
              { value: ACTION, label: "Owner…" },
              { value: "__unassign__", label: "Unassigned" },
              ...(ownerOptions ?? users.map((u) => ({ value: u.id, label: u.name }))),
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
            disabled={isViewer}
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

        <div className="w-40 shrink-0">
          <Select<string>
            size="sm"
            value={ACTION}
            disabled={isViewer}
            placeholder="Subsystem…"
            ariaLabel="Set subsystem for selected tasks"
            options={[
              { value: ACTION, label: "Subsystem…" },
              { value: "__none__", label: "No subsystem" },
              ...subsystemOptions,
            ]}
            onChange={(v) => {
              if (v === ACTION) return;
              apply({ subsystem_id: v === "__none__" ? null : v });
            }}
          />
        </div>

        <label className="flex shrink-0 items-center gap-1.5 text-xs text-helios-dim">
          Due
          <input
            type="date"
            aria-label="Set due date for selected tasks"
            disabled={isViewer}
            className="rounded border border-helios-line bg-helios-base px-1.5 py-1 text-xs text-helios-text focus:border-asu-gold focus:outline-none disabled:opacity-60"
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
          <button
            type="button"
            onClick={clearDue}
            disabled={isViewer}
            aria-label="Clear due date for selected tasks"
            title="Clear due date"
            className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400 disabled:opacity-60"
          >
            <IconX size={12} strokeWidth={1.5} />
          </button>
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
