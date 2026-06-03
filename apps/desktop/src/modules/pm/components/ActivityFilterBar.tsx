"use client";

import type { ActivityAction, Subteam, User } from "@helios/pm-ui";
import {
  IconArrowRight,
  IconCircleCheck,
  IconPlus,
  IconTrash,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import { Select } from "@pm/components/ui/Select";

// Only the actions the app currently emits get filter chips. (The DB trigger now
// logs 'deleted', so it joins created / status_changed / completed here.)
export const FILTERABLE_ACTIONS = [
  "created",
  "status_changed",
  "completed",
  "deleted",
] as const satisfies ReadonlyArray<ActivityAction>;

const ACTION_CHIP_LABEL: Record<(typeof FILTERABLE_ACTIONS)[number], string> = {
  created: "Created",
  status_changed: "Status",
  completed: "Completed",
  deleted: "Deleted",
};

const ACTION_CHIP_ICON: Record<(typeof FILTERABLE_ACTIONS)[number], TablerIcon> = {
  created: IconPlus,
  status_changed: IconArrowRight,
  completed: IconCircleCheck,
  deleted: IconTrash,
};

export interface ActivityFilters {
  actions: ReadonlyArray<ActivityAction>;
  subteamIds: ReadonlyArray<string>;
  actorId: string | null;
  search: string;
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = {
  actions: [],
  subteamIds: [],
  actorId: null,
  search: "",
};

export function activityFiltersActive(f: ActivityFilters): boolean {
  return (
    f.actions.length > 0 ||
    f.subteamIds.length > 0 ||
    f.actorId !== null ||
    f.search.trim() !== ""
  );
}

export function ActivityFilterBar({
  filters,
  subteams,
  users,
  active,
  scopedToTeam,
  onPatch,
  onClear,
}: {
  filters: ActivityFilters;
  subteams: ReadonlyArray<Subteam>;
  users: ReadonlyArray<User>;
  active: boolean;
  scopedToTeam: boolean;
  onPatch: (patch: Partial<ActivityFilters>) => void;
  onClear: () => void;
}) {
  function toggleAction(a: ActivityAction) {
    const set = new Set(filters.actions);
    if (set.has(a)) set.delete(a);
    else set.add(a);
    onPatch({ actions: [...set] });
  }
  function toggleSubteam(id: string) {
    const set = new Set(filters.subteamIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onPatch({ subteamIds: [...set] });
  }

  return (
    <div className="flex flex-col gap-3 border-b border-helios-line bg-helios-panel/40 px-6 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label="Search">
          <input
            type="search"
            value={filters.search}
            onChange={(e) => onPatch({ search: e.target.value })}
            placeholder="Target contains…"
            className={filterInput}
          />
        </FilterField>

        <FilterField label="Actor">
          <Select
            value={filters.actorId ?? ""}
            onChange={(v) => onPatch({ actorId: v ? v : null })}
            ariaLabel="Actor filter"
            className="min-w-[150px]"
            options={[
              { value: "", label: "All" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </FilterField>

        {active ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 self-end rounded border border-helios-line bg-transparent px-2 py-1.5 text-xs font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
          >
            <IconX size={12} strokeWidth={1.5} />
            Clear filters
          </button>
        ) : null}
      </div>

      {/* Scope filters: action chips + subteam chips */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
            Action
          </span>
          {FILTERABLE_ACTIONS.map((a) => {
            const isActive = filters.actions.includes(a);
            const Icon = ACTION_CHIP_ICON[a];
            return (
              <button
                key={a}
                type="button"
                onClick={() => toggleAction(a)}
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                  (isActive
                    ? "border-helios-text/40 bg-helios-base text-helios-text"
                    : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                }
              >
                <Icon size={12} strokeWidth={1.5} />
                {ACTION_CHIP_LABEL[a]}
              </button>
            );
          })}
        </div>

        {!scopedToTeam ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
              Subteams
            </span>
            {subteams.map((s) => {
              const isActive = filters.subteamIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSubteam(s.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                    (isActive
                      ? "border-helios-text/40 bg-helios-base text-helios-text"
                      : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                  }
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: s.color ?? "#6B7280" }}
                  />
                  {s.code}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        {label}
      </span>
      {children}
    </label>
  );
}

const filterInput =
  "rounded border border-helios-line bg-helios-base px-2 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none";

// Returns true if an activity row passes the filter predicate.
// action match AND subteam-overlap AND actor match AND search-over-target_name.
export function activityMatchesFilters(
  row: {
    action: ActivityAction;
    subteam_ids: ReadonlyArray<string>;
    actor_id: string | null;
    target_name: string | null;
    target_type: string;
  },
  filters: ActivityFilters,
): boolean {
  if (filters.actions.length > 0 && !filters.actions.includes(row.action)) {
    return false;
  }
  if (filters.subteamIds.length > 0) {
    const overlap = row.subteam_ids.some((id) => filters.subteamIds.includes(id));
    if (!overlap) return false;
  }
  if (filters.actorId !== null && row.actor_id !== filters.actorId) {
    return false;
  }
  const q = filters.search.trim().toLowerCase();
  if (q !== "") {
    const haystack = (row.target_name ?? row.target_type ?? "").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}
