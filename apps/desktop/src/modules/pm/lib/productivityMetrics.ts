// ---------------------------------------------------------------------------
// Productivity metrics — pure functions over the rows returned by the
// pm.task_history RPC. No React, no Supabase, no Date.now(): every entry point
// takes its reference time explicitly so the whole module is deterministic and
// unit-testable.
//
// The one rule worth internalising (spec decision 1): a task's completion time
// is DERIVED as the LATEST `completed` event for that task inside the window.
// A task that was finished, reopened and finished again counts ONCE, at its
// last completion. Nothing here reads a completed_at column, because there
// isn't one.
//
// Two of the RPC's actions are SYNTHESISED server-side rather than read from
// the activity log (migration 20260914000100):
//   - `open` — one per currently-open task, a LIVE SNAPSHOT that ignores the
//     window entirely. Open work with no recent activity (107 of 240 tasks in
//     prod) would otherwise be invisible to the aging panel. It is a STATE, not
//     an event: it feeds the open/aging numbers and nothing else — never
//     throughput, never the burn-up, never the CSV.
//   - `completed` with a null `status_from` — stands in for a completion the
//     trigger never logged (tasks seeded already-done). Indistinguishable from
//     a real completion here on purpose; it counts identically.
// ---------------------------------------------------------------------------

/** One row as pm.task_history returns it. Actor fields are NULL when the caller lacks pm.manage_dashboard in scope. */
export interface TaskHistoryRow {
  /** Empty for the server-synthesised `open` / backfilled `completed` rows. */
  activity_id: string;
  event_time: string;
  action: "created" | "status_changed" | "completed" | "deleted" | "open";
  task_id: string;
  task_title: string | null;
  subteam_id: string | null;
  subteam_name: string | null;
  status_from: string | null;
  status_to: string | null;
  actor_id: string | null;
  actor_name: string | null;
  task_created_at: string | null;
  due_date: string | null;
  task_status_now: string | null;
  estimate_days: number | null;
  actual_days: number | null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const UNKNOWN_SUBTEAM = "Unassigned";

// Statuses that mean "this task is finished". Everything else that still exists
// counts as open work for the aging panel.
const CLOSED_STATUSES = new Set(["done", "cancelled", "canceled"]);

export interface AgingBucketDef {
  label: string;
  /** Inclusive lower bound in days. */
  minDays: number;
  /** Inclusive upper bound in days, or null for the open-ended last bucket. */
  maxDays: number | null;
}

export const AGING_BUCKETS: ReadonlyArray<AgingBucketDef> = [
  { label: "0–7 days", minDays: 0, maxDays: 7 },
  { label: "8–14 days", minDays: 8, maxDays: 14 },
  { label: "15–30 days", minDays: 15, maxDays: 30 },
  { label: "30+ days", minDays: 31, maxDays: null },
];

const CYCLE_HISTOGRAM_BUCKETS: ReadonlyArray<AgingBucketDef> = [
  { label: "0–2 d", minDays: 0, maxDays: 2 },
  { label: "3–7 d", minDays: 3, maxDays: 7 },
  { label: "8–14 d", minDays: 8, maxDays: 14 },
  { label: "15–30 d", minDays: 15, maxDays: 30 },
  { label: "30+ d", minDays: 31, maxDays: null },
];

// --- small date helpers -----------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local-midnight copy of a date. Never mutates the argument. */
function atLocalMidnight(d: Date): Date {
  const copy = new Date(d.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Local calendar day as YYYY-MM-DD — the form task due dates are stored in. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * The Monday that starts the ISO-8601 week containing `d` (local time).
 */
export function isoWeekStart(d: Date): Date {
  const start = atLocalMidnight(d);
  // getDay(): 0 = Sunday. ISO weeks start Monday, so Sunday is offset 6.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

/**
 * ISO-8601 week label, e.g. "2026-W38". The year is the week's OWN year (the
 * year containing its Thursday), which is why 2027-01-01 reads "2026-W53".
 * Zero-padded so the keys sort lexicographically within a year.
 */
export function isoWeekKey(d: Date): string {
  // Move to the Thursday of this week; that date's year is the ISO week-year.
  const thursday = isoWeekStart(d);
  thursday.setDate(thursday.getDate() + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const firstWeekStart = isoWeekStart(jan4);
  const week = Math.round((thursday.getTime() - firstWeekStart.getTime()) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${pad2(week)}`;
}

/**
 * Linear-interpolated percentile (the "R-7" / Excel definition), so a 2-sample
 * median is the mean of the two. Returns null for an empty sample. The input
 * array is copied before sorting — callers keep their order.
 */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

function bucketize(
  defs: ReadonlyArray<AgingBucketDef>,
  days: ReadonlyArray<number>,
): Array<{ label: string; count: number }> {
  const out = defs.map((b) => ({ label: b.label, count: 0 }));
  for (const d of days) {
    for (let i = 0; i < defs.length; i += 1) {
      const def = defs[i]!;
      if (d >= def.minDays && (def.maxDays === null || d <= def.maxDays)) {
        out[i]!.count += 1;
        break;
      }
    }
  }
  return out;
}

// --- result shapes ----------------------------------------------------------

export interface WeekThroughput {
  week: string;
  /** Monday of the week, for axis labels. */
  weekStart: string;
  completed: number;
  created: number;
  /** Completions in this week keyed by subteam name. */
  bySubteam: Record<string, number>;
  /** Completions in this week keyed by actor name. Empty when actors are gated. */
  byPerson: Record<string, number>;
}

export interface BurnupPoint {
  week: string;
  weekStart: string;
  createdCumulative: number;
  completedCumulative: number;
}

export interface CycleTimeStat {
  subteamName: string;
  n: number;
  median: number | null;
  p85: number | null;
}

export interface OnTimeStat {
  /** Completions that had a due date, i.e. the denominator. */
  considered: number;
  onTime: number;
  rate: number | null;
  excludedNoDueDate: number;
}

export interface PersonStat {
  actorId: string;
  actorName: string;
  completions: number;
  medianCycleDays: number | null;
  onTimeRate: number | null;
  /**
   * Open tasks this person CREATED in the window (history has no owner column —
   * see below). An open task whose creation predates the window arrives as a
   * synthetic `open` row with no actor at all, so it counts toward `totalOpen`
   * but toward nobody's personal column.
   */
  open: number;
}

export interface ProductivityMetrics {
  totalCreated: number;
  totalCompleted: number;
  totalOpen: number;
  throughput: WeekThroughput[];
  burnup: BurnupPoint[];
  cycleTimeOverall: { n: number; median: number | null; p85: number | null };
  cycleTimeBySubteam: CycleTimeStat[];
  cycleHistogram: Array<{ label: string; count: number }>;
  onTime: OnTimeStat;
  aging: Array<{ label: string; count: number }>;
  /** True when the RPC returned at least one non-null actor, i.e. the caller is gated in. */
  actorsAvailable: boolean;
  /** Empty unless `actorsAvailable`. */
  perPerson: PersonStat[];
  /** Subteam names seen in the window, sorted — the stacked-chart series order. */
  subteamNames: string[];
}

export interface ProductivityOptions {
  /** Reference "now" for the aging buckets. Required; nothing here reads the clock. */
  now: Date;
}

// --- the builder ------------------------------------------------------------

interface CompletionRecord {
  taskId: string;
  at: Date;
  subteamName: string;
  actorId: string | null;
  actorName: string | null;
  dueDate: string | null;
  createdAt: Date | null;
}

function parseTs(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fold the raw history rows into every panel of the Productivity view.
 *
 * Person-level output is driven entirely by whether the server sent actors: if
 * every `actor_id` is null (the caller lacks pm.manage_dashboard in scope),
 * `actorsAvailable` is false and `perPerson` is empty, so the view has nothing
 * to render even by accident. The gate lives on the server; this is the mirror.
 */
export function buildProductivity(
  rows: ReadonlyArray<TaskHistoryRow>,
  opts: ProductivityOptions,
): ProductivityMetrics {
  const nowMidnightMs = atLocalMidnight(opts.now).getTime();

  // Tasks that were deleted inside the window drop out of every metric: their
  // completions are no longer real work anyone can point at, and they are not
  // open work either.
  const deleted = new Set<string>();
  for (const r of rows) if (r.action === "deleted") deleted.add(r.task_id);

  // Latest completion per task (spec decision 1).
  const lastCompletion = new Map<string, CompletionRecord>();
  // First `created` event per task, plus the task snapshot we need for aging.
  const createdAtByTask = new Map<string, Date>();
  const createdEvent = new Map<string, { at: Date; actorId: string | null; actorName: string | null }>();
  const snapshot = new Map<
    string,
    { statusNow: string | null; createdAt: Date | null; subteamName: string }
  >();

  let actorsAvailable = false;

  for (const r of rows) {
    if (r.actor_id) actorsAvailable = true;
    if (deleted.has(r.task_id)) continue;

    const subteamName = r.subteam_name ?? UNKNOWN_SUBTEAM;
    const taskCreatedAt = parseTs(r.task_created_at);
    if (taskCreatedAt && !createdAtByTask.has(r.task_id)) {
      createdAtByTask.set(r.task_id, taskCreatedAt);
    }
    // Later rows win for the live snapshot — they are all the same task row
    // server-side, but this keeps the newest non-null values.
    const prev = snapshot.get(r.task_id);
    snapshot.set(r.task_id, {
      statusNow: r.task_status_now ?? prev?.statusNow ?? null,
      createdAt: taskCreatedAt ?? prev?.createdAt ?? null,
      subteamName: r.subteam_name ?? prev?.subteamName ?? UNKNOWN_SUBTEAM,
    });

    const at = parseTs(r.event_time);
    if (!at) continue;

    if (r.action === "created") {
      const existing = createdEvent.get(r.task_id);
      if (!existing || at < existing.at) {
        createdEvent.set(r.task_id, { at, actorId: r.actor_id, actorName: r.actor_name });
      }
    } else if (r.action === "completed") {
      const existing = lastCompletion.get(r.task_id);
      // STRICTLY later wins, so the last completion in the window is the one
      // that counts. Ties keep the first row seen (stable).
      if (!existing || at > existing.at) {
        lastCompletion.set(r.task_id, {
          taskId: r.task_id,
          at,
          subteamName,
          actorId: r.actor_id,
          actorName: r.actor_name,
          dueDate: r.due_date,
          createdAt: taskCreatedAt,
        });
      }
    }
  }

  // Backfill each completion's created-at from any row that carried it.
  for (const c of lastCompletion.values()) {
    if (!c.createdAt) c.createdAt = createdAtByTask.get(c.taskId) ?? null;
  }

  // --- week series ----------------------------------------------------------
  const weekBuckets = new Map<string, WeekThroughput>();
  const touch = (d: Date): WeekThroughput => {
    const key = isoWeekKey(d);
    let b = weekBuckets.get(key);
    if (!b) {
      b = {
        week: key,
        weekStart: localDayKey(isoWeekStart(d)),
        completed: 0,
        created: 0,
        bySubteam: {},
        byPerson: {},
      };
      weekBuckets.set(key, b);
    }
    return b;
  };

  for (const ev of createdEvent.values()) touch(ev.at).created += 1;
  for (const c of lastCompletion.values()) {
    const b = touch(c.at);
    b.completed += 1;
    b.bySubteam[c.subteamName] = (b.bySubteam[c.subteamName] ?? 0) + 1;
    if (c.actorName) b.byPerson[c.actorName] = (b.byPerson[c.actorName] ?? 0) + 1;
  }

  // Fill the gaps so the chart has no missing columns: walk Mondays from the
  // first populated week to the last.
  const throughput: WeekThroughput[] = [];
  if (weekBuckets.size > 0) {
    const starts = [...weekBuckets.values()].map((b) => b.weekStart).sort();
    const [y0, m0, d0] = starts[0]!.split("-").map(Number);
    const [y1, m1, d1] = starts[starts.length - 1]!.split("-").map(Number);
    const cursor = new Date(y0!, m0! - 1, d0!);
    const end = new Date(y1!, m1! - 1, d1!);
    while (cursor.getTime() <= end.getTime()) {
      const key = isoWeekKey(cursor);
      throughput.push(
        weekBuckets.get(key) ?? {
          week: key,
          weekStart: localDayKey(cursor),
          completed: 0,
          created: 0,
          bySubteam: {},
          byPerson: {},
        },
      );
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  // --- burn-up --------------------------------------------------------------
  let cCreated = 0;
  let cCompleted = 0;
  const burnup: BurnupPoint[] = throughput.map((w) => {
    cCreated += w.created;
    cCompleted += w.completed;
    return {
      week: w.week,
      weekStart: w.weekStart,
      createdCumulative: cCreated,
      completedCumulative: cCompleted,
    };
  });

  // --- cycle time -----------------------------------------------------------
  const cycleAll: number[] = [];
  const cycleByTeam = new Map<string, number[]>();
  for (const c of lastCompletion.values()) {
    if (!c.createdAt) continue;
    const days = (c.at.getTime() - c.createdAt.getTime()) / MS_PER_DAY;
    if (days < 0) continue; // clock skew; not a real cycle
    cycleAll.push(days);
    const list = cycleByTeam.get(c.subteamName) ?? [];
    list.push(days);
    cycleByTeam.set(c.subteamName, list);
  }

  const cycleTimeBySubteam: CycleTimeStat[] = [...cycleByTeam.entries()]
    .map(([subteamName, vals]) => ({
      subteamName,
      n: vals.length,
      median: percentile(vals, 0.5),
      p85: percentile(vals, 0.85),
    }))
    .sort((a, b) => a.subteamName.localeCompare(b.subteamName));

  // --- on-time --------------------------------------------------------------
  let considered = 0;
  let onTimeCount = 0;
  let excludedNoDueDate = 0;
  for (const c of lastCompletion.values()) {
    if (!c.dueDate) {
      excludedNoDueDate += 1;
      continue;
    }
    considered += 1;
    // Compare calendar days, not instants: a task due the 10th and finished at
    // 23:00 on the 10th is on time.
    if (localDayKey(c.at) <= c.dueDate) onTimeCount += 1;
  }

  // --- open work aging ------------------------------------------------------
  const openTaskIds: string[] = [];
  const openAges: number[] = [];
  for (const [taskId, snap] of snapshot.entries()) {
    if (deleted.has(taskId)) continue;
    if (snap.statusNow === null) continue; // task row is gone — nothing to age
    if (CLOSED_STATUSES.has(snap.statusNow)) continue;
    openTaskIds.push(taskId);
    const created = snap.createdAt ?? createdAtByTask.get(taskId) ?? null;
    if (!created) continue;
    openAges.push(Math.max(0, Math.floor((nowMidnightMs - atLocalMidnight(created).getTime()) / MS_PER_DAY)));
  }
  const openSet = new Set(openTaskIds);

  // --- per person -----------------------------------------------------------
  // NOTE on `open`: the history carries the ACTOR of each event, not the task's
  // current owner (owners live in pm.task_owners, which this RPC deliberately
  // does not join — it would multiply the row count and widen the personal data
  // surface). So a person's open count is the open tasks they CREATED. The view
  // labels the column accordingly.
  const perPerson: PersonStat[] = [];
  if (actorsAvailable) {
    const byActor = new Map<
      string,
      { name: string; cycles: number[]; completions: number; due: number; onTime: number; open: number }
    >();
    const bump = (id: string, name: string | null) => {
      let e = byActor.get(id);
      if (!e) {
        e = { name: name ?? "Unknown", cycles: [], completions: 0, due: 0, onTime: 0, open: 0 };
        byActor.set(id, e);
      } else if (name && e.name === "Unknown") {
        e.name = name;
      }
      return e;
    };

    for (const c of lastCompletion.values()) {
      if (!c.actorId) continue;
      const e = bump(c.actorId, c.actorName);
      e.completions += 1;
      if (c.createdAt) {
        const days = (c.at.getTime() - c.createdAt.getTime()) / MS_PER_DAY;
        if (days >= 0) e.cycles.push(days);
      }
      if (c.dueDate) {
        e.due += 1;
        if (localDayKey(c.at) <= c.dueDate) e.onTime += 1;
      }
    }

    for (const [taskId, ev] of createdEvent.entries()) {
      if (!ev.actorId) continue;
      const e = bump(ev.actorId, ev.actorName);
      if (openSet.has(taskId)) e.open += 1;
    }

    for (const [actorId, e] of byActor.entries()) {
      perPerson.push({
        actorId,
        actorName: e.name,
        completions: e.completions,
        medianCycleDays: percentile(e.cycles, 0.5),
        onTimeRate: e.due > 0 ? e.onTime / e.due : null,
        open: e.open,
      });
    }
    // Most completions first, then most open work, then name.
    perPerson.sort(
      (a, b) =>
        b.completions - a.completions || b.open - a.open || a.actorName.localeCompare(b.actorName),
    );
  }

  const subteamNames = [...new Set(throughput.flatMap((w) => Object.keys(w.bySubteam)))].sort();

  return {
    totalCreated: createdEvent.size,
    totalCompleted: lastCompletion.size,
    totalOpen: openTaskIds.length,
    throughput,
    burnup,
    cycleTimeOverall: {
      n: cycleAll.length,
      median: percentile(cycleAll, 0.5),
      p85: percentile(cycleAll, 0.85),
    },
    cycleTimeBySubteam,
    cycleHistogram: bucketize(CYCLE_HISTOGRAM_BUCKETS, cycleAll),
    onTime: {
      considered,
      onTime: onTimeCount,
      rate: considered > 0 ? onTimeCount / considered : null,
      excludedNoDueDate,
    },
    aging: bucketize(AGING_BUCKETS, openAges),
    actorsAvailable,
    perPerson,
    subteamNames,
  };
}
