"use client";

import type { Subteam, TaskStatus, TaskType } from "@helios/pm-ui";
import { STATUS_DOT, STATUS_LABEL, TASK_STATUSES, TASK_TYPES } from "@helios/pm-ui";
import { IconEye, IconEyeOff, IconX } from "@tabler/icons-react";
import type { TaskFilters } from "@pm/lib/filters";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { PrimaryOnlyToggle } from "@pm/components/PrimaryOnlyToggle";

const STATUS_FILTER_OPTIONS: SelectOption<string>[] = [
  { value: "", label: "All" },
  ...TASK_STATUSES.map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
    swatch: STATUS_DOT[s],
  })),
];

export function TaskFilterBar({
  filters,
  subteams,
  users,
  active,
  scopedToTeam,
  hideTypes = false,
  primaryOnly,
  onPrimaryOnlyChange,
  onPatch,
  onClear,
}: {
  filters: TaskFilters;
  subteams: ReadonlyArray<Subteam>;
  users: ReadonlyArray<{ id: string; name: string }>;
  active: boolean;
  scopedToTeam: boolean;
  hideTypes?: boolean;
  /** Current "primary subteam only" pref. When provided alongside
   *  onPrimaryOnlyChange and a subteam scope is active, the bar shows the toggle. */
  primaryOnly?: boolean;
  onPrimaryOnlyChange?: (value: boolean) => void;
  onPatch: (patch: Partial<TaskFilters>) => void;
  onClear: () => void;
}) {
  function toggleSubteam(id: string) {
    const set = new Set(filters.subteamIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onPatch({ subteamIds: [...set] });
  }
  function toggleType(t: TaskType) {
    const set = new Set(filters.types);
    if (set.has(t)) set.delete(t);
    else set.add(t);
    onPatch({ types: [...set] });
  }
  const scopeActive = filters.subteamIds.length > 0 || filters.types.length > 0;

  return (
    <div className="flex flex-col gap-3 border-b border-helios-line bg-helios-panel/40 px-6 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label="Search">
          <input
            type="search"
            value={filters.search}
            onChange={(e) => onPatch({ search: e.target.value })}
            placeholder="Title contains…"
            className={filterInput}
          />
        </FilterField>

        <FilterField label="Status">
          <Select
            value={filters.status[0] ?? ""}
            onChange={(v) =>
              onPatch({ status: v ? ([v] as TaskStatus[]) : [] })
            }
            options={STATUS_FILTER_OPTIONS}
            ariaLabel="Status filter"
            className="min-w-[150px]"
          />
        </FilterField>

        <FilterField label="Owner">
          <Select
            value={filters.ownerIds[0] ?? ""}
            onChange={(v) => onPatch({ ownerIds: v ? [v] : [] })}
            ariaLabel="Owner filter"
            className="min-w-[150px]"
            options={[
              { value: "", label: "All" },
              { value: "__unassigned__", label: "Unassigned" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </FilterField>

        <FilterField label="Due from">
          <input
            type="date"
            value={filters.dueFrom ?? ""}
            onChange={(e) =>
              onPatch({ dueFrom: e.target.value === "" ? null : e.target.value })
            }
            className={filterInput}
          />
        </FilterField>

        <FilterField label="Due to">
          <input
            type="date"
            value={filters.dueTo ?? ""}
            onChange={(e) =>
              onPatch({ dueTo: e.target.value === "" ? null : e.target.value })
            }
            className={filterInput}
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

      {/* Scope filters: subteams + types + mode */}
      <div className="flex flex-col gap-2">
        {/* Inside a single subteam the subteam chips are meaningless (you're
            already scoped to one), so that row is replaced by the "primary only"
            toggle, which curates THIS subteam's own task list. */}
        {scopedToTeam && onPrimaryOnlyChange ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <PrimaryOnlyToggle value={primaryOnly ?? false} onChange={onPrimaryOnlyChange} />
          </div>
        ) : null}
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
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: s.color ?? "#6B7280" }} />
                  {s.code}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          {!hideTypes ? (
            <>
              <span className="mr-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">
                Types
              </span>
              {TASK_TYPES.map((t) => {
                const isActive = filters.types.includes(t);
                const isAssembly = t === "assembly";
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleType(t)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                      (isActive
                        ? isAssembly
                          ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
                          : "border-helios-text/40 bg-helios-base text-helios-text"
                        : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                    }
                  >
                    {t}
                  </button>
                );
              })}
            </>
          ) : null}

          {scopeActive ? (
            <div className="ml-auto inline-flex rounded-md border border-helios-line bg-helios-base p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => onPatch({ showMode: "dim" })}
                className={
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors " +
                  (filters.showMode === "dim"
                    ? "bg-helios-panel text-helios-text"
                    : "text-helios-dim hover:text-helios-text")
                }
              >
                <IconEyeOff size={11} strokeWidth={1.5} />
                Dim others
              </button>
              <button
                type="button"
                onClick={() => onPatch({ showMode: "hide" })}
                className={
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors " +
                  (filters.showMode === "hide"
                    ? "bg-helios-panel text-helios-text"
                    : "text-helios-dim hover:text-helios-text")
                }
              >
                <IconEye size={11} strokeWidth={1.5} />
                Hide others
              </button>
            </div>
          ) : null}
        </div>
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
