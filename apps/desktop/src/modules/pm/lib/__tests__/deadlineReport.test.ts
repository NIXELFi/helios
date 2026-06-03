import { describe, expect, test } from "vitest";
import type { Subteam, TaskRow } from "@helios/pm-ui";
import { buildDeadlineReport } from "../deadlineReport";

const SUBTEAM: Subteam = {
  id: "st1",
  name: "Aero",
  code: "AE",
  slug: "aero",
  color: "#f00",
};

let seq = 0;
function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  seq += 1;
  return {
    id: `t${seq}`,
    project_id: "p1",
    subteam_id: "st1",
    subsystem_id: null,
    parent_task_id: null,
    title: `Task ${seq}`,
    description: null,
    type: "general",
    status: "not_started",
    priority: "medium",
    owner_id: null,
    start_date: null,
    due_date: null,
    estimate_days: null,
    mrl: null,
    on_critical_path: false,
    subteam: SUBTEAM,
    subteams: [SUBTEAM],
    subsystem: null,
    owner: null,
    ...over,
  } as TaskRow;
}

// A fixed, unambiguous reference date. Mid-month + mid-day so a shared-Date
// mutation bug (setHours zeroing the time) would be detectable.
function refDate(): Date {
  return new Date(2026, 5, 15, 14, 30, 0); // 2026-06-15 14:30 local
}

describe("buildDeadlineReport", () => {
  test("classifies upcoming vs overdue and excludes done / null-due / out-of-window", () => {
    const tasks: TaskRow[] = [
      makeTask({ id: "today", due_date: "2026-06-15" }), // 0 days → upcoming
      makeTask({ id: "edge", due_date: "2026-06-29" }), // +14 days → upcoming (inclusive)
      makeTask({ id: "beyond", due_date: "2026-06-30" }), // +15 days → out of window
      makeTask({ id: "late", due_date: "2026-06-10" }), // -5 days → overdue
      makeTask({ id: "done", due_date: "2026-06-12", status: "done" }), // done → excluded
      makeTask({ id: "nodue", due_date: null }), // no due → excluded
    ];

    const report = buildDeadlineReport(tasks, refDate());

    expect(report.windowDays).toBe(14);
    expect(report.refDate).toBe("2026-06-15");

    const upcomingIds = report.upcoming.map((t) => t.id);
    const overdueIds = report.overdue.map((t) => t.id);

    expect(upcomingIds).toContain("today");
    expect(upcomingIds).toContain("edge");
    expect(upcomingIds).not.toContain("beyond");
    expect(upcomingIds).not.toContain("done");
    expect(upcomingIds).not.toContain("nodue");

    expect(overdueIds).toEqual(["late"]);
    expect(report.upcoming.find((t) => t.id === "today")!.daysUntilDue).toBe(0);
    expect(report.upcoming.find((t) => t.id === "edge")!.daysUntilDue).toBe(14);
  });

  test("upcoming sorts by due_date asc, then priority desc", () => {
    const tasks: TaskRow[] = [
      makeTask({ id: "b-low", due_date: "2026-06-20", priority: "low" }),
      makeTask({ id: "a", due_date: "2026-06-16", priority: "low" }),
      makeTask({ id: "b-critical", due_date: "2026-06-20", priority: "critical" }),
      makeTask({ id: "b-medium", due_date: "2026-06-20", priority: "medium" }),
    ];

    const report = buildDeadlineReport(tasks, refDate());

    // Earliest due first ("a"), then the 06-20 group ordered by priority desc.
    expect(report.upcoming.map((t) => t.id)).toEqual([
      "a",
      "b-critical",
      "b-medium",
      "b-low",
    ]);
  });

  test("overdue sorts most-overdue-first and carries daysOverdue = -daysUntilDue + priority", () => {
    const tasks: TaskRow[] = [
      makeTask({ id: "late2-low", due_date: "2026-06-13", priority: "low" }), // -2, low(0) → 2
      makeTask({ id: "late10-medium", due_date: "2026-06-05", priority: "medium" }), // -10, med(1) → 11
      makeTask({ id: "late2-critical", due_date: "2026-06-13", priority: "critical" }), // -2, crit(3) → 5
    ];

    const report = buildDeadlineReport(tasks, refDate());

    expect(report.overdue.map((t) => t.id)).toEqual([
      "late10-medium",
      "late2-critical",
      "late2-low",
    ]);

    const byId = Object.fromEntries(report.overdue.map((t) => [t.id, t]));
    expect(byId["late2-low"]!.daysUntilDue).toBe(-2);
    expect(byId["late2-low"]!.daysOverdue).toBe(2);
    expect(byId["late10-medium"]!.daysOverdue).toBe(11);
    expect(byId["late2-critical"]!.daysOverdue).toBe(5);
  });

  test("does not mutate the passed-in now Date (taskState.daysUntilDue gotcha)", () => {
    const now = refDate();
    const before = now.getTime();
    const tasks = [
      makeTask({ due_date: "2026-06-20" }),
      makeTask({ due_date: "2026-06-10" }),
      makeTask({ due_date: "2026-06-18" }),
    ];

    const report = buildDeadlineReport(tasks, now);

    // The original Date must keep its 14:30 wall-clock time — if the day math
    // had run setHours(0,0,0,0) on it, this would have been zeroed.
    expect(now.getTime()).toBe(before);
    expect(now.getHours()).toBe(14);

    // And the per-task day counts must all be correct (a shared mutated Date
    // would have corrupted every iteration after the first).
    const days = [...report.upcoming, ...report.overdue]
      .map((t) => t.daysUntilDue)
      .sort((a, b) => a - b);
    expect(days).toEqual([-5, 3, 5]);
  });
});
