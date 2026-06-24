"use client";

import type { Subteam } from "@helios/pm-ui";
import { IconChevronRight, IconEye, IconWorldOff } from "@tabler/icons-react";
import { useState } from "react";
import { SubteamIcon } from "@pm/components/SubteamIcon";

// A collapsible block, mounted BELOW the Subteams section, listing the subteams
// currently HIDDEN from the sidebar nav (server-wide or per-user). Purely a
// DISPLAY affordance: revealing a subteam here only adds its shortcut back to the
// sidebar — it never changes task assignment, membership, or permissions.
//
// Each hidden row gets an eye toggle:
//   - server-hidden  → "Show for me" (per-user unhide, localStorage)
//   - user-hidden    → "Show" (drop the per-user hide, localStorage)
// A capability holder (pm.manage_project_subteams) additionally gets a
// "Show for everyone" action on server-hidden rows (removes the server row).

export interface HiddenRow {
  subteam: Subteam;
  /** True if hidden server-wide (vs. only this user's local hide). */
  serverHidden: boolean;
}

export function HiddenSubteamsMenu({
  rows,
  canManage,
  onRevealForMe,
  onRevealForEveryone,
}: {
  rows: HiddenRow[];
  canManage: boolean;
  /** Reveal a hidden subteam for THIS user only (per-user localStorage). */
  onRevealForMe: (row: HiddenRow) => void;
  /** Admin-only: remove the server-wide hide so it shows for everyone. */
  onRevealForEveryone: (subteamId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (rows.length === 0) return null;

  return (
    <div className="mt-2 border-t border-helios-line px-2 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 pb-1.5 text-left"
      >
        <IconChevronRight
          size={13}
          strokeWidth={1.5}
          className={
            "shrink-0 text-helios-dim transition-transform " + (open ? "rotate-90" : "")
          }
        />
        <span className="text-xs font-medium uppercase tracking-widest text-helios-dim">
          Hidden subteams
        </span>
        <span className="ml-auto rounded-full bg-helios-base px-1.5 text-[10px] font-medium text-helios-dim">
          {rows.length}
        </span>
      </button>

      {open ? (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li key={row.subteam.id} className="group flex items-center">
              <span className="flex flex-1 items-center gap-2 rounded px-2 py-1 text-sm font-normal text-helios-dim/70">
                <SubteamIcon
                  name={row.subteam.name}
                  code={row.subteam.code}
                  size={17}
                  className="shrink-0 opacity-60"
                  style={{ color: row.subteam.color ?? "#6B7280" }}
                />
                <span className="truncate">{row.subteam.name}</span>
              </span>
              <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => onRevealForMe(row)}
                  aria-label={`Show ${row.subteam.name} for me`}
                  title={row.serverHidden ? "Show for me" : "Show"}
                  className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-asu-gold"
                >
                  <IconEye size={13} strokeWidth={1.5} />
                </button>
                {canManage && row.serverHidden ? (
                  <button
                    type="button"
                    onClick={() => onRevealForEveryone(row.subteam.id)}
                    aria-label={`Show ${row.subteam.name} for everyone`}
                    title="Show for everyone"
                    className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-asu-gold"
                  >
                    <IconWorldOff size={13} strokeWidth={1.5} />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
