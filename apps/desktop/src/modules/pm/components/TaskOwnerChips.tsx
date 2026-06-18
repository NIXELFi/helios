"use client";

import type { TaskRow, User } from "@helios/pm-ui";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
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
  const addTaskOwner = usePmStore((s) => s.addTaskOwner);
  const removeTaskOwner = usePmStore((s) => s.removeTaskOwner);

  const [pickerOpen, setPickerOpen] = useState(false);

  // Co-owners = all owners except the primary (owner_id). Falls back to an empty
  // list when a task has only its primary owner.
  const coOwners: User[] = useMemo(
    () => (task.owners ?? []).filter((u) => u.id !== task.owner_id),
    [task.owners, task.owner_id],
  );

  // Members not already an owner (primary or co), available to add.
  const available = useMemo(() => {
    if (!editable) return [];
    const ownerIds = new Set((task.owners ?? []).map((u) => u.id));
    if (task.owner_id) ownerIds.add(task.owner_id);
    return users.filter((u) => !ownerIds.has(u.id));
  }, [editable, users, task.owners, task.owner_id]);

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
        <span className="relative inline-flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen((o) => !o);
            }}
            aria-label="Add co-owner"
            aria-expanded={pickerOpen}
            className="inline-flex items-center gap-0.5 rounded border border-dashed border-helios-line px-1.5 py-0.5 text-[11px] leading-none text-helios-dim hover:border-helios-text/40 hover:text-helios-text"
          >
            <IconPlus size={11} strokeWidth={1.5} />
            Add
          </button>
          {pickerOpen ? (
            <>
              <button
                type="button"
                aria-label="Close owner picker"
                onClick={() => setPickerOpen(false)}
                className="fixed inset-0 z-[60] cursor-default"
              />
              <ul
                role="listbox"
                className="absolute left-0 top-full z-[70] mt-1 max-h-56 min-w-[10rem] overflow-y-auto rounded-md border border-helios-line bg-helios-panel py-1 shadow-xl"
              >
                {available.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        addTaskOwner(task.id, u.id);
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-helios-text hover:bg-helios-base"
                    >
                      <span className="truncate">{u.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
