import type { TaskPriority, TaskRow, TaskStatus } from "@helios/pm-ui";

// ---------------------------------------------------------------------------
// Deadlines Report — a pure, snapshot-able view of what's due soon and what's
// already late. Built imperatively from the store's `tasks` at the moment the
// user opens the report window (NOT a live subscription), so the numbers stay
// stable while the user reads / copies / exports them.
// ---------------------------------------------------------------------------

export const REPORT_WINDOW_DAYS = 14;

// Numeric weight for a task's priority. Higher = more urgent. Used both as the
// secondary sort key (priority desc) and as the tie-broken bump folded into a
// task's `daysOverdue` so a more critical late task ranks above an equally-late
// low-priority one.
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface ReportTask {
  id: string;
  title: string;
  due_date: string;
  priority: TaskPriority;
  status: TaskStatus;
  subteamName: string;
  subteamColor: string | null;
  ownerName: string | null;
  daysUntilDue: number;
  daysOverdue: number;
}

export interface DeadlineReport {
  // ISO timestamp of when this snapshot was generated.
  generatedAt: string;
  // The midnight calendar date (YYYY-MM-DD) the day math is measured against.
  refDate: string;
  windowDays: number;
  upcoming: ReportTask[];
  overdue: ReportTask[];
}

// Parse a YYYY-MM-DD task date into a local midnight Date. Mirrors the parser
// in pm-ui/taskState so day boundaries line up with the rest of the app.
function parseTaskDate(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (y && m && d) return new Date(y, m - 1, d);
  const fallback = new Date(iso);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toIsoDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Build the deadlines report from a snapshot of tasks.
 *
 * `now` is read ONCE and copied to a private midnight reference — we never pass
 * a shared mutable Date through the loop. (pm-ui's `daysUntilDue` MUTATES the
 * Date you hand it via `today.setHours(0,0,0,0)`, so reusing one Date across
 * tasks would corrupt later iterations. Here we zero the hours a single time on
 * our own copy and do the day arithmetic inline against its fixed timestamp.)
 */
export function buildDeadlineReport(
  tasks: ReadonlyArray<TaskRow>,
  now: Date,
): DeadlineReport {
  const generatedAt = now.toISOString();
  // Copy `now` and zero its time ONCE. `refMidnightMs` is a plain number from
  // here on, so nothing downstream can mutate the reference.
  const refMidnight = new Date(now.getTime());
  refMidnight.setHours(0, 0, 0, 0);
  const refMidnightMs = refMidnight.getTime();
  const refDate = toIsoDay(refMidnight);

  const upcoming: ReportTask[] = [];
  const overdue: ReportTask[] = [];

  for (const t of tasks) {
    if (t.due_date == null) continue;
    if (t.status === "done") continue;
    const due = parseTaskDate(t.due_date);
    if (!due) continue;

    // Inline day math against the fixed midnight timestamp — no Date mutation.
    const daysUntilDue = Math.floor((due.getTime() - refMidnightMs) / MS_PER_DAY);

    const weight = PRIORITY_WEIGHT[t.priority];
    const base: ReportTask = {
      id: t.id,
      title: t.title,
      due_date: t.due_date,
      priority: t.priority,
      status: t.status,
      subteamName: t.subteam?.name ?? "—",
      subteamColor: t.subteam?.color ?? null,
      ownerName: t.owner?.name ?? null,
      daysUntilDue,
      // For upcoming tasks this carries no overdue meaning (kept 0); for overdue
      // tasks it's how-late plus the priority bump (see below).
      daysOverdue: 0,
    };

    if (daysUntilDue < 0) {
      // Most-overdue-first ranking folds the priority weight in, so a critical
      // task that's N days late outranks a low task that's exactly N days late.
      overdue.push({ ...base, daysOverdue: -daysUntilDue + weight });
    } else if (daysUntilDue <= REPORT_WINDOW_DAYS) {
      upcoming.push(base);
    }
  }

  // Upcoming: soonest due first, then most-urgent priority first.
  upcoming.sort((a, b) => {
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
  });

  // Overdue: most overdue first (largest daysOverdue), priority already folded
  // in. Ties fall back to the earlier due date.
  overdue.sort((a, b) => {
    if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
    return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
  });

  return {
    generatedAt,
    refDate,
    windowDays: REPORT_WINDOW_DAYS,
    upcoming,
    overdue,
  };
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

// "in 3 days" / "today" / "5 days overdue" — a human phrasing of the day count.
function duePhrase(daysUntilDue: number): string {
  if (daysUntilDue === 0) return "today";
  if (daysUntilDue > 0) return `in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
  const late = -daysUntilDue;
  return `${late} day${late === 1 ? "" : "s"} overdue`;
}

/** Render the report as GitHub-flavored Markdown (two tables). */
export function reportToMarkdown(report: DeadlineReport): string {
  const lines: string[] = [];
  lines.push("# Deadlines report");
  lines.push("");
  lines.push(`_Generated ${report.generatedAt} · reference date ${report.refDate}_`);
  lines.push("");

  lines.push(`## Upcoming (next ${report.windowDays} days)`);
  lines.push("");
  if (report.upcoming.length === 0) {
    lines.push("_Nothing due in the window._");
  } else {
    lines.push("| Task | Due | Days | Priority | Owner | Subteam |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const t of report.upcoming) {
      lines.push(
        `| ${mdCell(t.title)} | ${t.due_date} | ${duePhrase(t.daysUntilDue)} | ${PRIORITY_LABEL[t.priority]} | ${mdCell(t.ownerName ?? "—")} | ${mdCell(t.subteamName)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Overdue");
  lines.push("");
  if (report.overdue.length === 0) {
    lines.push("_Nothing overdue._");
  } else {
    lines.push("| Task | Due | Days | Priority | Owner | Subteam |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const t of report.overdue) {
      lines.push(
        `| ${mdCell(t.title)} | ${t.due_date} | ${duePhrase(t.daysUntilDue)} | ${PRIORITY_LABEL[t.priority]} | ${mdCell(t.ownerName ?? "—")} | ${mdCell(t.subteamName)} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

/** Render the report as plain text (aligned-ish, pipe-free). */
export function reportToPlainText(report: DeadlineReport): string {
  const lines: string[] = [];
  lines.push("DEADLINES REPORT");
  lines.push(`Generated ${report.generatedAt}`);
  lines.push(`Reference date ${report.refDate}`);
  lines.push("");

  lines.push(`UPCOMING (next ${report.windowDays} days)`);
  if (report.upcoming.length === 0) {
    lines.push("  Nothing due in the window.");
  } else {
    for (const t of report.upcoming) {
      lines.push(`  ${textRow(t)}`);
    }
  }
  lines.push("");

  lines.push("OVERDUE");
  if (report.overdue.length === 0) {
    lines.push("  Nothing overdue.");
  } else {
    for (const t of report.overdue) {
      lines.push(`  ${textRow(t)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function textRow(t: ReportTask): string {
  const owner = t.ownerName ?? "unassigned";
  return `${t.title} — due ${t.due_date} (${duePhrase(t.daysUntilDue)}) · ${PRIORITY_LABEL[t.priority]} · ${owner} · ${t.subteamName}`;
}

// Escape pipes and newlines so a task title can't break the Markdown table.
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
