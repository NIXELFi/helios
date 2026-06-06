"use client";

import type { CalendarEvent, TaskPriority, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
import {
  STATUS_DOT,
  STATUS_FILL,
  STATUS_LABEL,
  TASK_STATUSES,
  TASK_TYPES,
  TASK_TYPE_LABEL,
  daysUntilDue,
} from "@helios/pm-ui";
import { addDays, addMonths, format, parseISO, startOfDay } from "date-fns";
import { useMemo } from "react";
import { ViewHeader } from "@pm/components/ViewHeader";
import {
  scopeTasksToSubteam,
  usePmStore,
  type CrossTeamRelation,
} from "@pm/lib/pmStore";

const DEADLINE_WINDOW_DAYS = 14;
const FALLBACK_COLOR = "#6B7280";

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

function dueText(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return `${-days}d overdue`;
}

// Next on-or-after-today occurrence of an event (handles recurrence). Returns
// null if the (non-recurring) event is in the past or recurrence has ended.
function nextEventDate(ev: CalendarEvent, today: Date): Date | null {
  const start = parseISO(ev.date);
  const rec = ev.recurrence ?? "none";
  if (rec === "none") return start >= today ? start : null;
  const end = ev.recurrence_end ? parseISO(ev.recurrence_end) : null;
  let cur = start;
  let guard = 0;
  while (cur < today && guard < 1000) {
    cur = rec === "daily" ? addDays(cur, 1) : rec === "weekly" ? addDays(cur, 7) : addMonths(cur, 1);
    guard++;
  }
  if (end && cur > end) return null;
  return cur;
}

export function DashboardViewClient({ teamSlug = null }: { teamSlug?: string | null }) {
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const deps = usePmStore((s) => s.dependencies);
  const events = usePmStore((s) => s.events);
  const selectTask = usePmStore((s) => s.selectTask);

  const currentTeam = teamSlug ? subteams.find((s) => s.slug === teamSlug) ?? null : null;
  const allTeams = currentTeam === null;

  const scoped = useMemo(
    () =>
      currentTeam
        ? scopeTasksToSubteam(tasks, deps, currentTeam.id)
        : tasks.map((task) => ({
            task,
            relation: "owned" as CrossTeamRelation,
            bridgeTaskIds: [] as string[],
          })),
    [tasks, deps, currentTeam],
  );
  const owned = useMemo(() => scoped.filter((r) => r.relation === "owned").map((r) => r.task), [scoped]);
  const external = useMemo(() => scoped.filter((r) => r.relation !== "owned"), [scoped]);

  // Status pie: every owned task due within the next 14 days (done INCLUDED, so
  // completing tasks visibly turns slices green).
  const pie = useMemo(() => {
    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    let total = 0;
    for (const t of owned) {
      const d = daysUntilDue(t.due_date);
      if (d === null || d < 0 || d > DEADLINE_WINDOW_DAYS) continue;
      counts[t.status] += 1;
      total += 1;
    }
    return { counts, total };
  }, [owned]);

  // Deadline list: not-done owned tasks due within the window OR overdue.
  const deadlineRows = useMemo(() => {
    const rows = owned
      .filter((t) => t.status !== "done")
      .map((t) => ({ t, d: daysUntilDue(t.due_date) }))
      .filter((r): r is { t: TaskRow; d: number } => r.d !== null && r.d <= DEADLINE_WINDOW_DAYS);
    rows.sort((a, b) => a.d - b.d);
    return rows;
  }, [owned]);

  // Task-type breakdown over owned tasks.
  const typeRows = useMemo(() => {
    const counts = Object.fromEntries(TASK_TYPES.map((ty) => [ty, 0])) as Record<TaskType, number>;
    for (const t of owned) counts[t.type] += 1;
    const rows = TASK_TYPES.map((ty) => ({ type: ty, count: counts[ty] })).filter((r) => r.count > 0);
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
    return { rows, max };
  }, [owned]);

  // Upcoming events (scoped), with countdowns.
  const upcomingEvents = useMemo(() => {
    const today = startOfDay(new Date());
    const scopedEvents = currentTeam
      ? events.filter((e) => e.all_subteams || e.subteam_ids.includes(currentTeam.id))
      : events;
    return scopedEvents
      .map((e) => ({ e, when: nextEventDate(e, today) }))
      .filter((x): x is { e: CalendarEvent; when: Date } => x.when !== null)
      .sort((a, b) => a.when.getTime() - b.when.getTime())
      .slice(0, 8);
  }, [events, currentTeam]);

  const prerequisites = external.filter((r) => r.relation === "prerequisite_of_team");
  const dependents = external.filter((r) => r.relation === "dependent_on_team");

  return (
    <>
      <ViewHeader
        title={currentTeam ? `${currentTeam.name} · Dashboard` : "All Subteams · Dashboard"}
        description="Upcoming deadlines, completion at a glance, and what's coming up — distilled."
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Status pie */}
          <Panel title={`Due in ${DEADLINE_WINDOW_DAYS} days · by status`}>
            <StatusPie counts={pie.counts} total={pie.total} />
          </Panel>

          {/* Type breakdown */}
          <Panel title="Task types">
            {typeRows.rows.length === 0 ? (
              <Empty>No tasks.</Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {typeRows.rows.map((r) => (
                  <li key={r.type} className="flex items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 truncate text-helios-dim">{TASK_TYPE_LABEL[r.type]}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded bg-helios-base">
                      <span
                        className="block h-full rounded bg-asu-gold/70"
                        style={{ width: `${typeRows.max ? (r.count / typeRows.max) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="w-6 shrink-0 text-right tabular-nums text-helios-text">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Upcoming events */}
          <Panel title="Upcoming events">
            {upcomingEvents.length === 0 ? (
              <Empty>Nothing scheduled.</Empty>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {upcomingEvents.map(({ e, when }) => {
                  const days = Math.round((startOfDay(when).getTime() - startOfDay(new Date()).getTime()) / 86400000);
                  return (
                    <li key={`${e.id}-${when.toISOString()}`} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-helios-text">{e.title}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-helios-dim">{format(when, "MMM d")}</span>
                      <span className={"shrink-0 text-[11px] tabular-nums " + (days <= 14 ? "text-asu-gold" : "text-helios-text")}>
                        {days === 0 ? "today" : `in ${days}d`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        {/* Deadline list */}
        <Panel className="mt-4" title={`Upcoming deadlines${deadlineRows.length ? ` · ${deadlineRows.length}` : ""}`}>
          {deadlineRows.length === 0 ? (
            <Empty>Nothing due in the next {DEADLINE_WINDOW_DAYS} days. 🎉</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-widest text-helios-dim">
                  <tr className="border-b border-helios-line">
                    <th className="py-1.5 pr-3 font-medium">Task</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Days left</th>
                    <th className="py-1.5 pr-3 font-medium">Priority</th>
                    <th className="py-1.5 pr-3 font-medium">Owner</th>
                    <th className="py-1.5 pr-3 font-medium">Type</th>
                    <th className="py-1.5 pr-3 font-medium">{allTeams ? "Subteam" : "Subsystem"}</th>
                  </tr>
                </thead>
                <tbody>
                  {deadlineRows.map(({ t, d }) => (
                    <tr
                      key={t.id}
                      onClick={() => selectTask(t.id)}
                      className="cursor-pointer border-b border-helios-line/50 hover:bg-helios-base/50"
                    >
                      <td className="max-w-[18rem] truncate py-1.5 pr-3 text-helios-text">{t.title}</td>
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1.5 text-helios-text">
                          <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: STATUS_DOT[t.status] }} />
                          {STATUS_LABEL[t.status]}
                        </span>
                      </td>
                      <td className={"py-1.5 pr-3 tabular-nums " + (d < 0 ? "text-red-400" : d <= 2 ? "text-orange-400" : "text-helios-text")}>
                        {dueText(d)}
                      </td>
                      <td className="py-1.5 pr-3 text-helios-text">{PRIORITY_LABEL[t.priority]}</td>
                      <td className="py-1.5 pr-3 text-helios-dim">{t.owner?.name ?? "Unassigned"}</td>
                      <td className="py-1.5 pr-3 text-helios-dim">{TASK_TYPE_LABEL[t.type]}</td>
                      <td className="py-1.5 pr-3">
                        {allTeams ? (
                          <span className="inline-flex items-center gap-1.5 text-helios-text">
                            <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.subteam.color ?? FALLBACK_COLOR }} />
                            {t.subteam.name}
                          </span>
                        ) : (
                          <span className="text-helios-text">{t.subsystem?.name ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Cross-subteam prerequisites / dependents (subteam scope only) */}
        {currentTeam ? (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Prerequisites from other subteams">
              <CrossTeamList rows={prerequisites} empty="No external prerequisites." />
            </Panel>
            <Panel title="Other subteams depending on us">
              <CrossTeamList rows={dependents} empty="No external dependents." />
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}

function StatusPie({ counts, total }: { counts: Record<TaskStatus, number>; total: number }) {
  const size = 132;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  if (total === 0) {
    return <Empty>No tasks due in {DEADLINE_WINDOW_DAYS} days.</Empty>;
  }
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          {TASK_STATUSES.filter((s) => counts[s] > 0).map((s) => {
            const frac = counts[s] / total;
            const dash = frac * C;
            const el = (
              <circle
                key={s}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={STATUS_FILL[s]}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-acc * C}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            acc += frac;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-medium tabular-nums text-helios-text">{total}</span>
          <span className="text-[10px] uppercase tracking-widest text-helios-dim">tasks</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {TASK_STATUSES.filter((s) => counts[s] > 0).map((s) => (
          <li key={s} className="flex items-center gap-2 text-xs">
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: STATUS_FILL[s] }} />
            <span className="min-w-0 flex-1 truncate text-helios-dim">{STATUS_LABEL[s]}</span>
            <span className="shrink-0 tabular-nums text-helios-text">{Math.round((counts[s] / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrossTeamList({
  rows,
  empty,
}: {
  rows: Array<{ task: TaskRow; relation: CrossTeamRelation }>;
  empty: string;
}) {
  const selectTask = usePmStore((s) => s.selectTask);
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => (
        <li key={r.task.id}>
          <button
            type="button"
            onClick={() => selectTask(r.task.id)}
            className="flex w-full items-center gap-2 rounded border border-helios-line bg-helios-base/30 px-2 py-1.5 text-left text-xs hover:bg-helios-base"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[r.task.status] }} />
            <span className="min-w-0 flex-1 truncate text-helios-text">{r.task.title}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-helios-dim">{r.task.subteam.code}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Panel({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={"rounded-lg border border-helios-line bg-helios-panel p-4 " + className}>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-widest text-helios-dim">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-helios-dim">{children}</p>;
}
