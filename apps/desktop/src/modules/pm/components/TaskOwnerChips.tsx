"use client";

import type { TaskRow, User } from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { useMemo } from "react";
import { Select } from "@pm/components/ui/Select";
import { ownerOptions } from "@pm/lib/ownerScope";
import { usePmStore } from "@pm/lib/pmStore";

export interface TaskOwnerChipsProps {
  task: TaskRow;
  /** When true, exposes add/remove controls; otherwise read-only. */
  editable?: boolean;
}

/**
 * Renders a task's CO-OWNERS — every owner except the primary (which is shown by
 * the Owner dropdown). Each co-owner is a chip with a remove control; an "+ Add"
 * affordance attaches another team member as a co-owner. A co-owner can edit the
 * task just like the primary owner (mirrors the can_edit_task RLS function).
 */
export function TaskOwnerChips({ task, editable = false }: TaskOwnerChipsProps) {
  const users = usePmStore((s) => s.users);
  const tasks = usePmStore((s) => s.tasks);
  const addTaskOwner = usePmStore((s) => s.addTaskOwner);
  const removeTaskOwner = usePmStore((s) => s.removeTaskOwner);

  // Co-owners = all owners except the primary (owner_id). Falls back to an empty
  // list when a task has only its primary owner.
  const coOwners: User[] = useMemo(
    () => (task.owners ?? []).filter((u) => u.id !== task.owner_id),
    [task.owners, task.owner_id],
  );

  // Members not already an owner (primary or co), available to add — grouped so
  // this task's own subteam comes first instead of the whole flat directory.
  const available = useMemo(() => {
    if (!editable) return [];
    const ownerIds = new Set((task.owners ?? []).map((u) => u.id));
    if (task.owner_id) ownerIds.add(task.owner_id);
    return ownerOptions(users, tasks, task.subteam_id, task.subteam?.name ?? null).filter(
      (o) => !ownerIds.has(o.value),
    );
  }, [editable, users, tasks, task.owners, task.owner_id, task.subteam_id, task.subteam?.name]);

  if (!editable && coOwners.length === 0) {
    return <span className="text-xs text-helios-dim">None</span>;
  }

  return (
    <div className="relative inline-flex flex-wrap items-center gap-1">
      {coOwners.map((u) => (
        <span
          key={u.id}
          className="inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base/60 px-1.5 py-0.5 text-[11px] leading-none text-helios-text"
          title={u.email ?? u.name}
        >
          <span className="font-medium">{u.name}</span>
          {editable ? (
            <button
              type="button"
              onClick={() => removeTaskOwner(task.id, u.id)}
              aria-label={`Remove co-owner ${u.name}`}
              title="Remove co-owner"
              className="shrink-0 rounded text-helios-dim hover:text-red-400"
            >
              <IconX size={11} strokeWidth={1.5} />
            </button>
          ) : null}
        </span>
      ))}

      {editable && available.length > 0 ? (
        // Fire-once action menu: pick a person, they become a chip, the control
        // resets to its placeholder. Select brings the search box and the
        // subteam grouping that the old hand-rolled <ul> had neither of.
        <span className="inline-flex min-w-[9rem]">
          <Select
            value=""
            onChange={(v) => {
              if (v) addTaskOwner(task.id, v);
            }}
            size="sm"
            ariaLabel="Add co-owner"
            placeholder="Add co-owner…"
            options={available}
          />
        </span>
      ) : null}
    </div>
  );
}
