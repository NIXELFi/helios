import { describe, expect, it } from "vitest";
import {
  AGING_BUCKETS,
  buildProductivity,
  isoWeekKey,
  percentile,
  sliceWindow,
  stateCounts,
  weeklyCompletions,
  windowDeltas,
  type TaskHistoryRow,
} from "@pm/lib/productivityMetrics";

// --- fixtures ---------------------------------------------------------------

let seq = 0;
function row(over: Partial<TaskHistoryRow> & Pick<TaskHistoryRow, "action" | "task_id" | "event_time">): TaskHistoryRow {
  seq += 1;
  return {
    activity_id: `a${seq}`,
    task_title: `Task ${over.task_id}`,
    subteam_id: "st-1",
    subteam_name: "Aero",
    status_from: null,
    status_to: null,
    actor_id: null,
    actor_name: null,
    task_created_at: null,
    due_date: null,
    task_status_now: null,
    estimate_days: null,
    actual_days: null,
    ...over,
  };
}

describe("isoWeekKey", () => {
  it("labels a mid-year date with its ISO week", () => {
    expect(isoWeekKey(new Date(2026, 8, 14))).toBe("2026-W38");
  });

  it("puts 2027-01-01 (a Friday) in 2026-W53, not 2027-W01", () => {
    // ISO-8601: a week belongs to the year containing its Thursday.
    expect(isoWeekKey(new Date(2027, 0, 1))).toBe("2026-W53");
  });

  it("puts 2025-12-29 (a Monday) in 2026-W01", () => {
    expect(isoWeekKey(new Date(2025, 11, 29))).toBe("2026-W01");
  });

  it("pads single-digit weeks to two characters so keys sort", () => {
    expect(isoWeekKey(new Date(2026, 0, 8))).toBe("2026-W02");
  });
});

describe("percentile", () => {
  it("returns null for an empty sample", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("returns the median of an odd sample", () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  it("interpolates the median of an even sample", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("computes p85", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.85)).toBeCloseTo(8.65, 5);
  });
});

describe("buildProductivity — completion rule", () => {
  it("counts a reopened-and-redone task ONCE, at its LAST completion", () => {
    const rows = [
      row({ action: "created", task_id: "t1", event_time: "2026-01-05T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z", task_status_now: "done" }),
      row({ action: "completed", task_id: "t1", event_time: "2026-01-08T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z", task_status_now: "done" }),
      row({ action: "status_changed", task_id: "t1", event_time: "2026-01-12T10:00:00Z", status_from: "done", status_to: "active", task_created_at: "2026-01-05T10:00:00Z", task_status_now: "done" }),
      row({ action: "completed", task_id: "t1", event_time: "2026-01-20T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z", task_status_now: "done" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(1);
    // Cycle time is measured to the LAST completion: Jan 5 -> Jan 20 = 15 days.
    expect(m.cycleTimeOverall.median).toBe(15);
    // And it lands in the week of the last completion only.
    const weeksWithCompletions = m.throughput.filter((w) => w.completed > 0);
    expect(weeksWithCompletions).toHaveLength(1);
    expect(weeksWithCompletions[0]!.week).toBe(isoWeekKey(new Date("2026-01-20T10:00:00Z")));
  });

  it("ignores a completion for a task that was later deleted", () => {
    const rows = [
      row({ action: "completed", task_id: "t1", event_time: "2026-01-08T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z" }),
      row({ action: "deleted", task_id: "t1", event_time: "2026-01-09T10:00:00Z" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(0);
  });
});

describe("buildProductivity — throughput + burn-up", () => {
  const rows = [
    row({ action: "created", task_id: "t1", event_time: "2026-01-05T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z" }),
    row({ action: "created", task_id: "t2", event_time: "2026-01-06T10:00:00Z", task_created_at: "2026-01-06T10:00:00Z", subteam_name: "Chassis", subteam_id: "st-2" }),
    row({ action: "completed", task_id: "t1", event_time: "2026-01-14T10:00:00Z", task_created_at: "2026-01-05T10:00:00Z" }),
    row({ action: "created", task_id: "t3", event_time: "2026-01-15T10:00:00Z", task_created_at: "2026-01-15T10:00:00Z" }),
    row({ action: "completed", task_id: "t2", event_time: "2026-01-16T10:00:00Z", task_created_at: "2026-01-06T10:00:00Z", subteam_name: "Chassis", subteam_id: "st-2" }),
  ];

  it("buckets completions per ISO week and splits them by subteam", () => {
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    const week3 = m.throughput.find((w) => w.week === isoWeekKey(new Date("2026-01-14T10:00:00Z")))!;
    expect(week3.completed).toBe(2);
    expect(week3.bySubteam["st-1"]).toBe(1);
    expect(week3.bySubteam["st-2"]).toBe(1);
    expect(m.subteams).toEqual([
      { id: "st-1", name: "Aero" },
      { id: "st-2", name: "Chassis" },
    ]);
  });

  it("emits a contiguous week series with no gaps", () => {
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    const keys = m.throughput.map((w) => w.week);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("burns up cumulative created and completed", () => {
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    const last = m.burnup[m.burnup.length - 1]!;
    expect(last.createdCumulative).toBe(3);
    expect(last.completedCumulative).toBe(2);
    // Monotonic non-decreasing.
    for (let i = 1; i < m.burnup.length; i += 1) {
      expect(m.burnup[i]!.createdCumulative).toBeGreaterThanOrEqual(m.burnup[i - 1]!.createdCumulative);
      expect(m.burnup[i]!.completedCumulative).toBeGreaterThanOrEqual(m.burnup[i - 1]!.completedCumulative);
    }
  });
});

describe("buildProductivity — cycle time", () => {
  it("reports median and p85 per subteam plus a histogram", () => {
    const mk = (id: string, createdDay: number, doneDay: number, team: string) => [
      row({ action: "created", task_id: id, event_time: `2026-03-${String(createdDay).padStart(2, "0")}T00:00:00Z`, task_created_at: `2026-03-${String(createdDay).padStart(2, "0")}T00:00:00Z`, subteam_name: team, subteam_id: team }),
      row({ action: "completed", task_id: id, event_time: `2026-03-${String(doneDay).padStart(2, "0")}T00:00:00Z`, task_created_at: `2026-03-${String(createdDay).padStart(2, "0")}T00:00:00Z`, subteam_name: team, subteam_id: team }),
    ];
    const rows = [
      ...mk("a", 1, 3, "Aero"),
      ...mk("b", 1, 5, "Aero"),
      ...mk("c", 1, 11, "Aero"),
      ...mk("d", 1, 2, "Chassis"),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-04-01T00:00:00Z") });
    const aero = m.cycleTimeBySubteam.find((s) => s.subteamName === "Aero")!;
    expect(aero.n).toBe(3);
    expect(aero.median).toBe(4);
    expect(aero.p85).toBeCloseTo(8.2, 5);
    const chassis = m.cycleTimeBySubteam.find((s) => s.subteamName === "Chassis")!;
    expect(chassis.median).toBe(1);
    // Histogram totals equal the completions with a known creation time.
    expect(m.cycleHistogram.reduce((a, b) => a + b.count, 0)).toBe(4);
  });

  it("skips completions whose task_created_at is unknown", () => {
    const rows = [row({ action: "completed", task_id: "t1", event_time: "2026-01-08T10:00:00Z" })];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(1);
    expect(m.cycleTimeOverall.n).toBe(0);
    expect(m.cycleTimeOverall.median).toBeNull();
  });
});

describe("buildProductivity — on-time rate", () => {
  it("excludes tasks with no due date and reports the exclusion count", () => {
    const rows = [
      row({ action: "completed", task_id: "t1", event_time: "2026-01-08T10:00:00Z", due_date: "2026-01-10" }),
      row({ action: "completed", task_id: "t2", event_time: "2026-01-12T10:00:00Z", due_date: "2026-01-10" }),
      row({ action: "completed", task_id: "t3", event_time: "2026-01-12T10:00:00Z", due_date: null }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.onTime.considered).toBe(2);
    expect(m.onTime.onTime).toBe(1);
    expect(m.onTime.rate).toBe(0.5);
    expect(m.onTime.excludedNoDueDate).toBe(1);
  });

  it("counts a completion ON the due date as on time", () => {
    // Built from a LOCAL date so the assertion holds in any machine timezone:
    // on-time compares the completion's local calendar day to the due date.
    const rows = [
      row({
        action: "completed",
        task_id: "t1",
        event_time: new Date(2026, 0, 10, 23, 0, 0).toISOString(),
        due_date: "2026-01-10",
      }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.onTime.onTime).toBe(1);
    expect(m.onTime.rate).toBe(1);
  });

  it("has a null rate when nothing qualifies", () => {
    const m = buildProductivity([], { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.onTime.rate).toBeNull();
  });
});

describe("buildProductivity — open work aging", () => {
  it("buckets open tasks by age and leaves done/deleted tasks out", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const rows = [
      // 3 days old, open
      row({ action: "created", task_id: "t1", event_time: "2026-01-29T00:00:00Z", task_created_at: "2026-01-29T00:00:00Z", task_status_now: "active" }),
      // 10 days old, open
      row({ action: "created", task_id: "t2", event_time: "2026-01-22T00:00:00Z", task_created_at: "2026-01-22T00:00:00Z", task_status_now: "backlog" }),
      // 20 days old, open
      row({ action: "created", task_id: "t3", event_time: "2026-01-12T00:00:00Z", task_created_at: "2026-01-12T00:00:00Z", task_status_now: "blocked" }),
      // 60 days old, open
      row({ action: "created", task_id: "t4", event_time: "2025-12-03T00:00:00Z", task_created_at: "2025-12-03T00:00:00Z", task_status_now: "active" }),
      // done -> not open
      row({ action: "created", task_id: "t5", event_time: "2026-01-20T00:00:00Z", task_created_at: "2026-01-20T00:00:00Z", task_status_now: "done" }),
      // deleted -> not open
      row({ action: "created", task_id: "t6", event_time: "2026-01-20T00:00:00Z", task_created_at: "2026-01-20T00:00:00Z", task_status_now: "active" }),
      row({ action: "deleted", task_id: "t6", event_time: "2026-01-21T00:00:00Z" }),
    ];
    const m = buildProductivity(rows, { now });
    expect(m.aging.map((b) => b.count)).toEqual([1, 1, 1, 1]);
    expect(m.aging.map((b) => b.label)).toEqual(AGING_BUCKETS.map((b) => b.label));
    expect(m.totalOpen).toBe(4);
  });
});

describe("buildProductivity — person aggregation", () => {
  it("hides people entirely when the RPC returned no actors", () => {
    const rows = [row({ action: "completed", task_id: "t1", event_time: "2026-01-08T10:00:00Z", task_created_at: "2026-01-01T00:00:00Z" })];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.actorsAvailable).toBe(false);
    expect(m.perPerson).toEqual([]);
  });

  it("aggregates completions, cycle time, on-time and open work per person", () => {
    const rows = [
      row({ action: "created", task_id: "t1", event_time: "2026-01-01T00:00:00Z", task_created_at: "2026-01-01T00:00:00Z", actor_id: "u1", actor_name: "Ada", task_status_now: "done" }),
      row({ action: "completed", task_id: "t1", event_time: "2026-01-05T00:00:00Z", task_created_at: "2026-01-01T00:00:00Z", actor_id: "u1", actor_name: "Ada", due_date: "2026-01-06", task_status_now: "done" }),
      row({ action: "created", task_id: "t2", event_time: "2026-01-01T00:00:00Z", task_created_at: "2026-01-01T00:00:00Z", actor_id: "u1", actor_name: "Ada", task_status_now: "done" }),
      row({ action: "completed", task_id: "t2", event_time: "2026-01-11T00:00:00Z", task_created_at: "2026-01-01T00:00:00Z", actor_id: "u1", actor_name: "Ada", due_date: "2026-01-06", task_status_now: "done" }),
      row({ action: "created", task_id: "t3", event_time: "2026-01-02T00:00:00Z", task_created_at: "2026-01-02T00:00:00Z", actor_id: "u2", actor_name: "Grace", task_status_now: "active" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.actorsAvailable).toBe(true);
    const ada = m.perPerson.find((p) => p.actorId === "u1")!;
    expect(ada.actorName).toBe("Ada");
    expect(ada.completions).toBe(2);
    expect(ada.medianCycleDays).toBe(7);
    expect(ada.onTimeRate).toBe(0.5);
    expect(ada.open).toBe(0);
    const grace = m.perPerson.find((p) => p.actorId === "u2")!;
    expect(grace.completions).toBe(0);
    expect(grace.open).toBe(1);
    expect(grace.onTimeRate).toBeNull();
    // Most completions first.
    expect(m.perPerson[0]!.actorId).toBe("u1");
  });
});

describe("buildProductivity — synthetic rows from the RPC", () => {
  // The RPC emits a synthetic `open` row per currently-open task (a LIVE
  // snapshot, deliberately not window-filtered) so that open work with no
  // recent activity is still visible. It is a state, not an event: it must
  // never be counted as a creation or a completion.
  it("ages a task whose ONLY row is a synthetic open row", () => {
    const rows = [
      row({
        action: "open",
        task_id: "t1",
        event_time: "2025-11-01T00:00:00Z",
        task_created_at: "2025-11-01T00:00:00Z",
        task_status_now: "designing",
      }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalOpen).toBe(1);
    // 92 days old -> the last bucket.
    expect(m.aging[3]!.count).toBe(1);
    // ...and it is NOT work anyone did in the window.
    expect(m.totalCreated).toBe(0);
    expect(m.totalCompleted).toBe(0);
    expect(m.throughput).toEqual([]);
    expect(m.burnup).toEqual([]);
  });

  it("does not double-count a task that has both an open row and a created event", () => {
    const rows = [
      row({ action: "created", task_id: "t1", event_time: "2026-01-20T00:00:00Z", task_created_at: "2026-01-20T00:00:00Z", task_status_now: "designing" }),
      row({ action: "open", task_id: "t1", event_time: "2026-01-20T00:00:00Z", task_created_at: "2026-01-20T00:00:00Z", task_status_now: "designing" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalOpen).toBe(1);
    expect(m.totalCreated).toBe(1);
    expect(m.throughput.reduce((a, w) => a + w.created, 0)).toBe(1);
  });

  it("drops an open row for a task that was also deleted in the window", () => {
    const rows = [
      row({ action: "open", task_id: "t1", event_time: "2026-01-01T00:00:00Z", task_created_at: "2026-01-01T00:00:00Z", task_status_now: "designing" }),
      row({ action: "deleted", task_id: "t1", event_time: "2026-01-09T00:00:00Z" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalOpen).toBe(0);
  });

  // The RPC also synthesises a `completed` row (status_from null, status_to
  // 'done', timestamped updated_at) for done tasks the activity log never
  // recorded a completion for — 46 of prod's were seeded already-done.
  it("counts a synthetic completion exactly like a logged one", () => {
    const rows = [
      row({
        action: "completed",
        task_id: "t1",
        event_time: "2026-01-20T00:00:00Z",
        status_from: null,
        status_to: "done",
        task_created_at: "2026-01-10T00:00:00Z",
        task_status_now: "done",
        due_date: "2026-01-25",
      }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(1);
    expect(m.cycleTimeOverall.median).toBe(10);
    expect(m.onTime.rate).toBe(1);
    expect(m.totalOpen).toBe(0);
  });

  it("keeps the LAST completion when a synthetic and a logged one both arrive", () => {
    const rows = [
      row({ action: "completed", task_id: "t1", event_time: "2026-01-12T00:00:00Z", task_created_at: "2026-01-10T00:00:00Z", task_status_now: "done" }),
      // A synthetic row stamped later (updated_at moved after the completion).
      row({ action: "completed", task_id: "t1", event_time: "2026-01-20T00:00:00Z", status_to: "done", task_created_at: "2026-01-10T00:00:00Z", task_status_now: "done" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(1);
    expect(m.cycleTimeOverall.median).toBe(10);
  });

  it("leaves open rows out of the per-person open count (they carry no actor)", () => {
    const rows = [
      row({ action: "created", task_id: "t1", event_time: "2026-01-02T00:00:00Z", task_created_at: "2026-01-02T00:00:00Z", actor_id: "u1", actor_name: "Ada", task_status_now: "designing" }),
      row({ action: "open", task_id: "t1", event_time: "2026-01-02T00:00:00Z", task_created_at: "2026-01-02T00:00:00Z", task_status_now: "designing" }),
      // No creation event in the window -> nobody owns this one's open count.
      row({ action: "open", task_id: "t2", event_time: "2025-06-02T00:00:00Z", task_created_at: "2025-06-02T00:00:00Z", task_status_now: "designing" }),
    ];
    const m = buildProductivity(rows, { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalOpen).toBe(2);
    expect(m.perPerson.find((p) => p.actorId === "u1")!.open).toBe(1);
  });
});

describe("buildProductivity — empty window", () => {
  it("returns a well-formed empty result", () => {
    const m = buildProductivity([], { now: new Date("2026-02-01T00:00:00Z") });
    expect(m.totalCompleted).toBe(0);
    expect(m.totalCreated).toBe(0);
    expect(m.throughput).toEqual([]);
    expect(m.burnup).toEqual([]);
    expect(m.cycleTimeBySubteam).toEqual([]);
    expect(m.aging.every((b) => b.count === 0)).toBe(true);
  });
});

// --- windows, deltas and live state (Productivity overhaul) ------------------

describe("buildProductivity — window padding", () => {
  it("pads the week series to the whole window when from/to are given", () => {
    const rows = [row({ action: "completed", task_id: "a", event_time: "2026-09-09T10:00:00Z" })];
    const m = buildProductivity(rows, {
      now: new Date(2026, 8, 14),
      from: new Date(2026, 7, 24),
      to: new Date(2026, 8, 14),
    });
    expect(m.throughput.map((w) => w.weekStart)).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
    ]);
    expect(m.throughput.map((w) => w.completed)).toEqual([0, 0, 1, 0]);
  });
});

describe("sliceWindow", () => {
  const rows = [
    row({ action: "completed", task_id: "a", event_time: "2026-09-01T10:00:00Z" }),
    row({ action: "completed", task_id: "b", event_time: "2026-09-08T10:00:00Z" }),
    row({ action: "open", task_id: "c", event_time: "2026-03-01T10:00:00Z", task_status_now: "in_progress" }),
  ];
  it("keeps events inside the window and every open row regardless", () => {
    const out = sliceWindow(rows, new Date("2026-09-07T00:00:00Z"), new Date("2026-09-14T00:00:00Z"));
    expect(out.map((r) => r.task_id)).toEqual(["b", "c"]);
  });
  it("is inclusive at both ends", () => {
    const out = sliceWindow(rows, new Date("2026-09-01T10:00:00Z"), new Date("2026-09-08T10:00:00Z"));
    expect(out.map((r) => r.task_id)).toEqual(["a", "b", "c"]);
  });
});

describe("weeklyCompletions", () => {
  it("zero-fills N weeks ending in the week of endingAt, oldest first", () => {
    const rows = [
      row({ action: "completed", task_id: "a", event_time: "2026-09-01T10:00:00Z" }),
      // Re-done: counts once, at the LAST completion.
      row({ action: "completed", task_id: "a", event_time: "2026-09-09T10:00:00Z" }),
      row({ action: "completed", task_id: "b", event_time: "2026-09-09T11:00:00Z" }),
    ];
    const s = weeklyCompletions(rows, { weeks: 4, endingAt: new Date(2026, 8, 14) });
    expect(s.map((w) => w.weekStart)).toEqual(["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(s.map((w) => w.completed)).toEqual([0, 0, 2, 0]);
  });
});

describe("windowDeltas", () => {
  const cur = buildProductivity(
    [
      row({ action: "completed", task_id: "a", event_time: "2026-09-09T10:00:00Z", due_date: "2026-09-10" }),
      row({ action: "completed", task_id: "b", event_time: "2026-09-09T10:00:00Z", due_date: "2026-09-01" }),
    ],
    { now: new Date("2026-09-14T00:00:00Z") },
  );
  const prev = buildProductivity(
    [row({ action: "completed", task_id: "z", event_time: "2026-09-02T10:00:00Z", due_date: "2026-09-03" })],
    { now: new Date("2026-09-14T00:00:00Z") },
  );
  it("compares completed counts and on-time points against the previous window", () => {
    const d = windowDeltas(cur, prev);
    expect(d.completed).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(d.onTimePct).toEqual({ value: 50, previous: 100, delta: -50 });
  });
  it("reports null deltas with no previous window", () => {
    const d = windowDeltas(cur, null);
    expect(d.completed.delta).toBeNull();
    expect(d.onTimePct.delta).toBeNull();
    expect(d.onTimePct.value).toBe(50);
  });
});

describe("stateCounts", () => {
  // Wednesday 2026-09-16; the ISO week runs Monday the 14th to Sunday the 20th.
  const now = new Date(2026, 8, 16, 9, 0, 0);
  const rows = [
    row({ action: "open", task_id: "a", event_time: "x", task_status_now: "in_progress", due_date: "2026-09-16" }),
    row({ action: "open", task_id: "b", event_time: "x", task_status_now: "blocked", due_date: "2026-09-20" }),
    row({ action: "open", task_id: "c", event_time: "x", task_status_now: "needs_review", due_date: "2026-09-21" }),
    row({ action: "open", task_id: "d", event_time: "x", task_status_now: "not_started", due_date: "2026-09-01" }),
    row({ action: "open", task_id: "e", event_time: "x", task_status_now: "not_started", due_date: null }),
    row({ action: "open", task_id: "f", event_time: "x", task_status_now: "done", due_date: "2026-09-16" }),
    row({ action: "completed", task_id: "g", event_time: "2026-09-15T10:00:00Z", task_status_now: "done" }),
  ];
  it("counts due-this-week, overdue, stuck and no-due-date over the open snapshot only", () => {
    const c = stateCounts(rows, now);
    expect(c.open).toBe(5);
    expect(c.dueThisWeek).toBe(2); // a (today) + b (Sunday); c is next week
    expect(c.overdue).toBe(1);
    expect(c.noDueDate).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.needsReview).toBe(1);
    expect(c.stuck).toBe(2);
    expect(c.dueByDay).toEqual([0, 0, 1, 0, 0, 0, 1]);
  });
});
