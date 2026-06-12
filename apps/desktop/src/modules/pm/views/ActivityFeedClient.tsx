"use client";

import type { Activity, ActivityAction } from "@helios/pm-ui";
import {
  IconArrowRight,
  IconCircleCheck,
  IconLink,
  IconLinkOff,
  IconPencil,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconUserCircle,
  type TablerIcon,
} from "@tabler/icons-react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { useMemo, useState } from "react";
import { ViewHeader } from "@pm/components/ViewHeader";
import { usePmStore } from "@pm/lib/pmStore";
import { useScrollMemory } from "@pm/lib/useScrollMemory";
import {
  ActivityFilterBar,
  activityFiltersActive,
  activityMatchesFilters,
  EMPTY_ACTIVITY_FILTERS,
  type ActivityFilters,
} from "@pm/components/ActivityFilterBar";

const ACTION_ICON: Record<ActivityAction, TablerIcon> = {
  created: IconPlus,
  updated: IconPencil,
  deleted: IconTrash,
  status_changed: IconArrowRight,
  linked: IconLink,
  unlinked: IconLinkOff,
  completed: IconCircleCheck,
  reviewed: IconSparkles,
};

const ACTION_LABEL: Record<ActivityAction, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  status_changed: "Status changed",
  linked: "Linked",
  unlinked: "Unlinked",
  completed: "Completed",
  reviewed: "Flagged for review",
};

export interface ActivityFeedClientProps {
  teamSlug?: string | null;
}

export function ActivityFeedClient({ teamSlug = null }: ActivityFeedClientProps) {
  const scrollMemRef = useScrollMemory(`activity:${teamSlug ?? "__project__"}`);
  const activity = usePmStore((s) => s.activity);
  const subteams = usePmStore((s) => s.subteams);
  const users = usePmStore((s) => s.users);

  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_ACTIVITY_FILTERS);
  const patchFilters = (patch: Partial<ActivityFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }));
  const clearFilters = () => setFilters(EMPTY_ACTIVITY_FILTERS);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;
  const scopedToTeam = currentTeam !== null;
  const subteamById = new Map(subteams.map((s) => [s.id, s] as const));
  const userById = new Map(users.map((u) => [u.id, u] as const));

  // Team scope (route) first, then the user-driven filter predicate.
  const teamScoped = currentTeam
    ? activity.filter((a) => a.subteam_ids.includes(currentTeam.id))
    : activity;

  const filtered = useMemo(
    () => teamScoped.filter((a) => activityMatchesFilters(a, filters)),
    [teamScoped, filters],
  );

  const filtersActive = activityFiltersActive(filters);

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Activity` : "Activity"}
        description={`${filtered.length} event${filtered.length === 1 ? "" : "s"} · newest first`}
      />

      <ActivityFilterBar
        filters={filters}
        subteams={subteams}
        users={users}
        active={filtersActive}
        scopedToTeam={scopedToTeam}
        onPatch={patchFilters}
        onClear={clearFilters}
      />

      <div ref={scrollMemRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {filtered.length === 0 ? (
          <div className="rounded-md border border-helios-line bg-helios-panel p-8 text-center text-helios-dim">
            {filtersActive
              ? "No activity matches the current filters."
              : "No activity yet. Create, edit, or move a task to populate the feed."}
          </div>
        ) : (
          <ol className="divide-y divide-helios-line rounded-md border border-helios-line bg-helios-panel">
            {filtered.map((row) => (
              <ActivityRow
                key={row.id}
                row={row}
                actorName={row.actor_id ? userById.get(row.actor_id)?.name ?? null : null}
                teams={row.subteam_ids
                  .map((id) => subteamById.get(id))
                  .filter((t): t is NonNullable<typeof t> => Boolean(t))}
              />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function ActivityRow({
  row,
  actorName,
  teams,
}: {
  row: Activity;
  actorName: string | null;
  teams: ReadonlyArray<{ id: string; name: string; code: string; color: string | null }>;
}) {
  const Icon = ACTION_ICON[row.action];
  const when = (() => {
    try {
      return formatDistanceToNow(parseISO(row.created_at), { addSuffix: true });
    } catch {
      return row.created_at;
    }
  })();
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-helios-base text-helios-dim">
        <Icon size={12} strokeWidth={1.5} />
      </span>
      <div className="flex-1 space-y-1">
        <p className="font-normal text-helios-text">
          <span className="text-helios-dim">{ACTION_LABEL[row.action]} · </span>
          {row.target_name ?? row.target_type}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {actorName ? (
            <span className="inline-flex items-center gap-1 text-helios-dim">
              <IconUserCircle size={12} strokeWidth={1.5} />
              {actorName}
            </span>
          ) : (
            <span className="text-helios-dim italic">System</span>
          )}
          {teams.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase tracking-widest"
              style={{
                color: t.color ?? "#9097A0",
                borderColor: (t.color ?? "#9097A0") + "55",
              }}
            >
              <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.color ?? "#6B7280" }} />
              {t.name}
            </span>
          ))}
        </div>

        {row.payload ? (
          <p className="text-xs text-helios-dim">{describePayload(row)}</p>
        ) : null}
      </div>
      <span className="shrink-0 text-xs text-helios-dim tabular-nums">{when}</span>
    </li>
  );
}

function describePayload(row: Activity): string {
  const p = row.payload as Record<string, unknown> | null;
  if (!p) return "";
  if (row.action === "status_changed") {
    return `${String(p.from ?? "")} → ${String(p.to ?? "")}`;
  }
  if (row.action === "linked" && typeof p.predecessor === "string") {
    return `after "${p.predecessor}"`;
  }
  if (row.action === "unlinked" && typeof p.predecessor === "string") {
    return `unlinked from "${p.predecessor}"`;
  }
  if (row.action === "reviewed") {
    const reason = typeof p.reason === "string" ? p.reason : null;
    const rev = typeof p.rev === "string" ? p.rev : null;
    if (rev) return `${reason ?? "review"} · rev ${rev}`;
    return reason ?? "";
  }
  if (row.action === "updated") {
    const fields = Object.keys(p);
    return fields.length > 0 ? `Changed: ${fields.join(", ")}` : "";
  }
  if (row.action === "created" && typeof p.type === "string") {
    return `${p.type}`;
  }
  if (row.action === "deleted" && typeof p.type === "string") {
    return `${p.type} removed`;
  }
  return "";
}
