"use client";

import type { Subteam, TaskRow } from "@helios/pm-ui";
import { IconPlus, IconStar, IconStarFilled } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { ContextMenu, type MenuAction } from "@pm/components/ui/ContextMenu";
import { usePmStore } from "@pm/lib/pmStore";

export interface TaskSubteamChipsProps {
  task: TaskRow;
  /** When true, chips expose primary/membership controls; otherwise read-only. */
  editable?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  subteamId: string;
}

/**
 * Renders a task's full subteam membership as a row of chips (color dot + code).
 * The PRIMARY chip (id === task.subteam_id) carries a filled gold star; the rest
 * show a hollow star.
 *
 * Editable mode adds: click a non-primary star to promote it to primary;
 * right-click any chip for a "Set as primary" / "Remove from task" menu; and a
 * "+ Add subteam" affordance to attach a subteam that isn't yet a member.
 */
export function TaskSubteamChips({ task, editable = false }: TaskSubteamChipsProps) {
  const orgSubteams = usePmStore((s) => s.subteams);
  const baselineSubteams = usePmStore((s) => s.baselineOrg.subteams);
  const addTaskSubteam = usePmStore((s) => s.addTaskSubteam);
  const removeTaskSubteam = usePmStore((s) => s.removeTaskSubteam);
  const setPrimarySubteam = usePmStore((s) => s.setPrimarySubteam);
  const reassignPrimarySubteam = usePmStore((s) => s.reassignPrimarySubteam);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The membership list. Fall back to the embedded primary if (for any reason)
  // the list is missing, so a chip always renders.
  const members: Subteam[] = task.subteams?.length ? task.subteams : [task.subteam];

  // Subteams not yet a member, available to add (active org, then baseline).
  const available = useMemo(() => {
    if (!editable) return [];
    const memberIds = new Set(members.map((m) => m.id));
    const pool = orgSubteams.length ? orgSubteams : baselineSubteams;
    return pool.filter((s) => !memberIds.has(s.id));
  }, [editable, members, orgSubteams, baselineSubteams]);

  const menuActions: MenuAction[] = useMemo(() => {
    if (!menu) return [];
    const isPrimary = menu.subteamId === task.subteam_id;
    const actions: MenuAction[] = [];
    actions.push({
      label: "Set as primary",
      onClick: () => setPrimarySubteam(task.id, menu.subteamId),
      disabledReason: isPrimary ? "Already the primary subteam" : undefined,
    });
    if (isPrimary) {
      // The primary membership can't be removed directly (every task must keep
      // at least one), so instead offer to REASSIGN the primary onto another org
      // subteam — which re-homes the task and drops this (catch-all) primary.
      // The ContextMenu has no nested-submenu support, so the "submenu" is a
      // flat run of "Reassign primary to <name>" entries, one per candidate.
      const pool = orgSubteams.length ? orgSubteams : baselineSubteams;
      const candidates = pool.filter((s) => s.id !== task.subteam_id);
      if (candidates.length === 0) {
        actions.push({
          label: "Reassign primary to…",
          danger: true,
          onClick: () => {},
          disabledReason: "No other subteam to reassign to",
        });
      } else {
        for (const s of candidates) {
          actions.push({
            label: `Reassign primary to ${s.name}`,
            danger: true,
            onClick: () => reassignPrimarySubteam(task.id, s.id),
          });
        }
      }
    } else {
      actions.push({
        label: "Remove from task",
        danger: true,
        onClick: () => removeTaskSubteam(task.id, menu.subteamId),
      });
    }
    return actions;
  }, [
    menu,
    task.id,
    task.subteam_id,
    orgSubteams,
    baselineSubteams,
    setPrimarySubteam,
    removeTaskSubteam,
    reassignPrimarySubteam,
  ]);

  return (
    <div className="relative inline-flex flex-wrap items-center gap-1">
      {members.map((s) => {
        const isPrimary = s.id === task.subteam_id;
        return (
          <span
            key={s.id}
            onContextMenu={
              editable
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, subteamId: s.id });
                  }
                : undefined
            }
            className={
              "group/chip inline-flex items-center gap-1 rounded border border-helios-line " +
              "bg-helios-base/60 px-1.5 py-0.5 text-[11px] leading-none text-helios-text"
            }
            title={s.name}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color ?? "#6B7280" }}
            />
            <span className="font-medium">{s.code}</span>
            {isPrimary ? (
              <IconStarFilled
                size={11}
                className="shrink-0 text-asu-gold"
                aria-label="Primary subteam"
              />
            ) : editable ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPrimarySubteam(task.id, s.id);
                }}
                aria-label={`Set ${s.name} as primary subteam`}
                title="Set as primary"
                className="shrink-0 text-helios-dim opacity-40 transition-opacity hover:text-asu-gold group-hover/chip:opacity-100"
              >
                <IconStar size={11} />
              </button>
            ) : (
              <IconStar
                size={11}
                className="shrink-0 text-helios-dim opacity-50"
                aria-hidden
              />
            )}
          </span>
        );
      })}

      {editable && available.length > 0 ? (
        <span className="relative inline-flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen((o) => !o);
            }}
            aria-label="Add subteam"
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
                aria-label="Close subteam picker"
                onClick={() => setPickerOpen(false)}
                className="fixed inset-0 z-[60] cursor-default"
              />
              <ul
                role="listbox"
                className="absolute left-0 top-full z-[70] mt-1 max-h-56 min-w-[10rem] overflow-y-auto rounded-md border border-helios-line bg-helios-panel py-1 shadow-xl"
              >
                {available.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        addTaskSubteam(task.id, s.id);
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-helios-text hover:bg-helios-base"
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: s.color ?? "#6B7280" }}
                      />
                      <span className="truncate">{s.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </span>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
