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
//     prod) would otherwise be invisible to the state panels. It is a STATE,
//     not an event: it feeds the open / due / stuck numbers and nothing else —
//     never throughput, never the CSV.
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
  // --- v3 columns (migration 20260914000200). Each is null when the server
  // has not applied v3 yet — the client degrades, it never crashes. ---
  /** When the task entered its current status (latest matching status_changed, else updated_at). */
  status_since: string | null;
  task_updated_at: string | null;
  /** Owners, primary first. Ungated. null = unowned, or unknown on a pre-v3 server. */
  owner_ids: string[] | null;
  /** The server's gate verdict. null on a pre-v3 server (infer from actor_id then). */
  may_see_actors: boolean | null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const UNKNOWN_SUBTEAM = "Unassigned";

// Statuses that mean "this task is finished". Everything else that still exists
// counts as open work.
const CLOSED_STATUSES = new Set(["done", "cancelled", "canceled"]);

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

// --- result shapes ----------------------------------------------------------

export interface WeekThroughput {
  week: string;
  /** Monday of the week, for axis labels. */
  weekStart: string;
  completed: number;
  created: number;
  /** Completions in this week keyed by subteam ID ("" = no subteam), so series colour by id. */
  bySubteam: Record<string, number>;
  /** Completions in this week keyed by actor name. Empty when actors are gated. */
  byPerson: Record<string, number>;
}

export interface OnTimeStat {
  /** Completions that had a due date, i.e. the denominator. */
  considered: number;
  onTime: number;
  rate: number | null;
  excludedNoDueDate: number;
}

export interface SubteamOnTime extends OnTimeStat {
  /** "" = no subteam. */
  subteamId: string;
  subteamName: string;
}

export interface PersonStat {
  actorId: string;
  actorName: string;
  completions: number;
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
  onTime: OnTimeStat;
  /** On-time per subteam, sorted by name. Only meaningful beside the no-due-date count. */
  onTimeBySubteam: SubteamOnTime[];
  /** True when the RPC returned at least one non-null actor, i.e. the caller is gated in. */
  actorsAvailable: boolean;
  /** Empty unless `actorsAvailable`. */
  perPerson: PersonStat[];
  /** Subteams seen in the window, sorted by name — the stacked-chart series order. "" id = no subteam. */
  subteams: Array<{ id: string; name: string }>;
}

export interface ProductivityOptions {
  /** Reference "now". Required; nothing here reads the clock. */
  now: Date;
  /**
   * The selected window. When given, the week series is padded to cover it
   * end to end (an empty week is a real zero, not a missing column); without
   * it the series spans the first populated week to the last.
   */
  from?: Date;
  to?: Date;
}

// --- the builder ------------------------------------------------------------

interface CompletionRecord {
  taskId: string;
  at: Date;
  subteamId: string;
  subteamName: string;
  actorId: string | null;
  actorName: string | null;
  dueDate: string | null;
  createdAt: Date | null;
}

function parseDayKey(key: string | undefined): Date | null {
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
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
          subteamId: r.subteam_id ?? "",
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
    b.bySubteam[c.subteamId] = (b.bySubteam[c.subteamId] ?? 0) + 1;
    if (c.actorName) b.byPerson[c.actorName] = (b.byPerson[c.actorName] ?? 0) + 1;
  }

  // Fill the gaps so the chart has no missing columns: walk Mondays from the
  // first week (of the window when given, else the first populated) to the last.
  const throughput: WeekThroughput[] = [];
  const starts = [...weekBuckets.values()].map((b) => b.weekStart).sort();
  const firstStart = opts.from ? isoWeekStart(opts.from) : parseDayKey(starts[0]);
  const lastStart = opts.to ? isoWeekStart(opts.to) : parseDayKey(starts[starts.length - 1]);
  if (firstStart && lastStart) {
    const cursor = new Date(firstStart.getTime());
    const end = lastStart;
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

  // --- on-time --------------------------------------------------------------
  let considered = 0;
  let onTimeCount = 0;
  let excludedNoDueDate = 0;
  const onTimeByTeam = new Map<string, SubteamOnTime>();
  for (const c of lastCompletion.values()) {
    let team = onTimeByTeam.get(c.subteamId);
    if (!team) {
      team = {
        subteamId: c.subteamId,
        subteamName: c.subteamName,
        considered: 0,
        onTime: 0,
        rate: null,
        excludedNoDueDate: 0,
      };
      onTimeByTeam.set(c.subteamId, team);
    }
    if (!c.dueDate) {
      excludedNoDueDate += 1;
      team.excludedNoDueDate += 1;
      continue;
    }
    considered += 1;
    team.considered += 1;
    // Compare calendar days, not instants: a task due the 10th and finished at
    // 23:00 on the 10th is on time.
    if (localDayKey(c.at) <= c.dueDate) {
      onTimeCount += 1;
      team.onTime += 1;
    }
  }
  const onTimeBySubteam = [...onTimeByTeam.values()]
    .map((t) => ({ ...t, rate: t.considered > 0 ? t.onTime / t.considered : null }))
    .sort((a, b) => a.subteamName.localeCompare(b.subteamName));

  // --- open work ------------------------------------------------------------
  const openTaskIds: string[] = [];
  for (const [taskId, snap] of snapshot.entries()) {
    if (deleted.has(taskId)) continue;
    if (snap.statusNow === null) continue; // task row is gone
    if (CLOSED_STATUSES.has(snap.statusNow)) continue;
    openTaskIds.push(taskId);
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
      { name: string; completions: number; due: number; onTime: number; open: number }
    >();
    const bump = (id: string, name: string | null) => {
      let e = byActor.get(id);
      if (!e) {
        e = { name: name ?? "Unknown", completions: 0, due: 0, onTime: 0, open: 0 };
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

  const subteamById = new Map<string, string>();
  for (const c of lastCompletion.values()) subteamById.set(c.subteamId, c.subteamName);
  const subteams = [...subteamById.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    totalCreated: createdEvent.size,
    totalCompleted: lastCompletion.size,
    totalOpen: openTaskIds.length,
    throughput,
    onTime: {
      considered,
      onTime: onTimeCount,
      rate: considered > 0 ? onTimeCount / considered : null,
      excludedNoDueDate,
    },
    onTimeBySubteam,
    actorsAvailable,
    perPerson,
    subteams,
  };
}

// --- windows and comparisons ------------------------------------------------

/**
 * Keep the EVENT rows whose time falls inside [from, to] and every synthetic
 * `open` row regardless (they are a live snapshot, not events — see the header
 * note). Lets one wide RPC pull feed the selected window, the previous window
 * and the trailing sparkline context without three round trips.
 */
export function sliceWindow(
  rows: ReadonlyArray<TaskHistoryRow>,
  from: Date,
  to: Date,
): TaskHistoryRow[] {
  const lo = from.getTime();
  const hi = to.getTime();
  return rows.filter((r) => {
    if (r.action === "open") return true;
    const t = parseTs(r.event_time);
    return t !== null && t.getTime() >= lo && t.getTime() <= hi;
  });
}

/**
 * Completions per ISO week for the `weeks` weeks ending in the week of
 * `endingAt`, oldest first, zero-filled — the sparkline series. Same
 * last-completion-per-task rule as everything else, evaluated over the rows
 * given (pass the wide pull, not a slice).
 */
export function weeklyCompletions(
  rows: ReadonlyArray<TaskHistoryRow>,
  opts: { weeks: number; endingAt: Date },
): Array<{ week: string; weekStart: string; completed: number }> {
  const deleted = new Set<string>();
  for (const r of rows) if (r.action === "deleted") deleted.add(r.task_id);
  const last = new Map<string, Date>();
  for (const r of rows) {
    if (r.action !== "completed" || deleted.has(r.task_id)) continue;
    const at = parseTs(r.event_time);
    if (!at) continue;
    const prev = last.get(r.task_id);
    if (!prev || at > prev) last.set(r.task_id, at);
  }
  const counts = new Map<string, number>();
  for (const at of last.values()) {
    const k = isoWeekKey(at);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const n = Math.max(1, opts.weeks);
  const out: Array<{ week: string; weekStart: string; completed: number }> = [];
  const cursor = isoWeekStart(opts.endingAt);
  cursor.setDate(cursor.getDate() - 7 * (n - 1));
  for (let i = 0; i < n; i += 1) {
    const key = isoWeekKey(cursor);
    out.push({ week: key, weekStart: localDayKey(cursor), completed: counts.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}

export interface WindowDelta {
  /** Current-window value. */
  value: number;
  /** Previous-window value, null when there is nothing to compare against. */
  previous: number | null;
  /** value - previous, null when previous is null. */
  delta: number | null;
}

export interface WindowDeltas {
  completed: WindowDelta;
  /** On-time rate in percentage points (0-100); null when no completion had a due date. */
  onTimePct: { value: number | null; previous: number | null; delta: number | null };
}

/**
 * "Is this better or worse than last time?" for the two windowed numbers.
 * The previous window is the caller's business (same length, ending where
 * this one starts); this only does the arithmetic and the null-handling.
 */
export function windowDeltas(
  current: ProductivityMetrics,
  previous: ProductivityMetrics | null,
): WindowDeltas {
  const pct = (m: ProductivityMetrics | null): number | null =>
    m === null || m.onTime.rate === null ? null : Math.round(m.onTime.rate * 100);
  const curPct = pct(current);
  const prevPct = pct(previous);
  return {
    completed: {
      value: current.totalCompleted,
      previous: previous ? previous.totalCompleted : null,
      delta: previous ? current.totalCompleted - previous.totalCompleted : null,
    },
    onTimePct: {
      value: curPct,
      previous: prevPct,
      delta: curPct !== null && prevPct !== null ? curPct - prevPct : null,
    },
  };
}

// --- live state (what is due, what is stuck) --------------------------------

/** Statuses that mean "someone is waiting on someone" — the stuck set. */
export const STUCK_STATUSES: ReadonlySet<string> = new Set(["blocked", "needs_review"]);

export interface StateCounts {
  open: number;
  /** Open, due today through the coming Sunday (inclusive). */
  dueThisWeek: number;
  /** Open, due before today. */
  overdue: number;
  /** Open with no due date at all — a hygiene number, not a risk one. */
  noDueDate: number;
  blocked: number;
  needsReview: number;
  stuck: number;
  /** Open tasks due on each day Monday..Sunday of the current ISO week. */
  dueByDay: number[];
}

/**
 * Counts over the live open snapshot. Everything here is a STATE question so
 * it ignores the window entirely; `now` decides what "today" and "this week"
 * mean. Deleted tasks never reach the snapshot (the RPC emits open rows from
 * pm.tasks, and a deleted task has no row).
 */
export function stateCounts(rows: ReadonlyArray<TaskHistoryRow>, now: Date): StateCounts {
  const today = localDayKey(now);
  const monday = isoWeekStart(now);
  const dayKeys: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(monday.getTime());
    d.setDate(d.getDate() + i);
    dayKeys.push(localDayKey(d));
  }
  const sunday = dayKeys[6]!;

  const out: StateCounts = {
    open: 0,
    dueThisWeek: 0,
    overdue: 0,
    noDueDate: 0,
    blocked: 0,
    needsReview: 0,
    stuck: 0,
    dueByDay: [0, 0, 0, 0, 0, 0, 0],
  };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.action !== "open" || seen.has(r.task_id)) continue;
    seen.add(r.task_id);
    if (r.task_status_now === null || CLOSED_STATUSES.has(r.task_status_now)) continue;
    out.open += 1;
    if (r.task_status_now === "blocked") out.blocked += 1;
    if (r.task_status_now === "needs_review") out.needsReview += 1;
    if (STUCK_STATUSES.has(r.task_status_now)) out.stuck += 1;
    if (!r.due_date) {
      out.noDueDate += 1;
      continue;
    }
    if (r.due_date < today) out.overdue += 1;
    else if (r.due_date <= sunday) out.dueThisWeek += 1;
    const dayIdx = dayKeys.indexOf(r.due_date);
    if (dayIdx >= 0) out.dueByDay[dayIdx]! += 1;
  }
  return out;
}

// --- attention lists (what a lead chases on Monday) --------------------------

export interface AttentionItem {
  taskId: string;
  title: string;
  subteamId: string | null;
  subteamName: string | null;
  status: string;
  dueDate: string | null;
  /**
   * Whole days: overdue-by for the due lists, in-status for stuck lists, since
   * last touch for the stale list. null when the server sent no v3 timestamps.
   */
  days: number | null;
  ownerIds: string[];
}

export interface AttentionLists {
  /** Open, due before today. Most recently slipped first — the ones still worth chasing. */
  overdue: AttentionItem[];
  /** Open, due today through Sunday, soonest first. */
  dueThisWeek: AttentionItem[];
  /** needs_review for longer than `reviewDays`, longest first. */
  needsReview: AttentionItem[];
  /** Every blocked task, longest blocked first. */
  blocked: AttentionItem[];
  /** in_progress and not touched for `staleDays` or more, longest first. */
  stale: AttentionItem[];
  /** False when no row carried status_since / task_updated_at (pre-v3 server): the age filters were skipped. */
  agesKnown: boolean;
}

export interface AttentionOptions {
  /** Needs-review threshold in days. Default 7. */
  reviewDays?: number;
  /** Untouched in-progress threshold in days. Default 14. */
  staleDays?: number;
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((atLocalMidnight(to).getTime() - atLocalMidnight(from).getTime()) / MS_PER_DAY));
}

/**
 * The four questions behind the Attention column, answered from the live open
 * snapshot. Ages come from the v3 columns (time in status / last touch), never
 * from created_at, which is the import date for most of the corpus. On a
 * pre-v3 server the age-gated lists fall back to "every task in that status"
 * with null days, and `agesKnown` tells the view to say so.
 */
export function attentionLists(
  rows: ReadonlyArray<TaskHistoryRow>,
  now: Date,
  opts: AttentionOptions = {},
): AttentionLists {
  const reviewDays = opts.reviewDays ?? 7;
  const staleDays = opts.staleDays ?? 14;
  const today = localDayKey(now);
  const sunday = isoWeekStart(now);
  sunday.setDate(sunday.getDate() + 6);
  const sundayKey = localDayKey(sunday);

  const out: AttentionLists = {
    overdue: [],
    dueThisWeek: [],
    needsReview: [],
    blocked: [],
    stale: [],
    agesKnown: false,
  };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.action !== "open" || seen.has(r.task_id)) continue;
    seen.add(r.task_id);
    const status = r.task_status_now;
    if (status === null || CLOSED_STATUSES.has(status)) continue;

    const since = parseTs(r.status_since);
    const updated = parseTs(r.task_updated_at);
    if (since || updated) out.agesKnown = true;
    const inStatus = since ? wholeDaysBetween(since, now) : updated ? wholeDaysBetween(updated, now) : null;
    const lastTouch =
      since && updated
        ? wholeDaysBetween(new Date(Math.max(since.getTime(), updated.getTime())), now)
        : inStatus;

    const base = {
      taskId: r.task_id,
      title: r.task_title ?? "Untitled task",
      subteamId: r.subteam_id,
      subteamName: r.subteam_name,
      status,
      dueDate: r.due_date,
      ownerIds: r.owner_ids ?? [],
    };

    if (r.due_date && r.due_date < today) {
      const due = parseDayKey(r.due_date);
      out.overdue.push({ ...base, days: due ? wholeDaysBetween(due, now) : null });
    } else if (r.due_date && r.due_date <= sundayKey) {
      const due = parseDayKey(r.due_date);
      out.dueThisWeek.push({ ...base, days: due ? wholeDaysBetween(now, due) : null });
    }

    if (status === "blocked") {
      out.blocked.push({ ...base, days: inStatus });
    } else if (status === "needs_review") {
      if (inStatus === null || inStatus > reviewDays) out.needsReview.push({ ...base, days: inStatus });
    } else if (status === "in_progress") {
      if (lastTouch === null || lastTouch >= staleDays) out.stale.push({ ...base, days: lastTouch });
    }
  }

  const byTitle = (a: AttentionItem, b: AttentionItem) => a.title.localeCompare(b.title);
  const daysDesc = (a: AttentionItem, b: AttentionItem) => (b.days ?? -1) - (a.days ?? -1) || byTitle(a, b);
  // Overdue: most recently slipped first (smallest overdue-by). A task that
  // slipped yesterday is the one that can still be rescued.
  out.overdue.sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || byTitle(a, b));
  out.dueThisWeek.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || byTitle(a, b));
  out.needsReview.sort(daysDesc);
  out.blocked.sort(daysDesc);
  out.stale.sort(daysDesc);
  return out;
}
