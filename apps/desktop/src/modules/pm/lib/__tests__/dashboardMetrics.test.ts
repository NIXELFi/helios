import { describe, expect, test } from "vitest";
import { addDays, format } from "date-fns";
import {
  STATUS_FILL,
  TASK_STATUSES,
  type Subsystem,
  type Subteam,
  type TaskRow,
  type User,
} from "@helios/pm-ui";
import {
  computeMetric,
  filterSet,
  groupTasks,
  subteamStats,
  workloadByOwner,
} from "../dashboardMetrics";

const AERO: Subteam = { id: "st-aero", name: "Aero", code: "AE", slug: "aero", color: "#f00" };
const CHASSIS: Subteam = { id: "st-ch", name: "Chassis", code: "CH", slug: "chassis", color: "#0f0" };
const SUB_A: Subsystem = {
  id: "ss-a",
  subteam_id: "st-aero",
  parent_subsystem_id: null,
  name: "Wing",
  code: "WNG",
  color: null,
};
const ANA: User = { id: "u-ana", name: "Ana", email: null };
const BEN: User = { id: "u-ben", name: "Ben", email: null };

function iso(offsetDays: number): string {
  return format(addDays(new Date(), offsetDays), "yyyy-MM-dd");
}

let seq = 0;
function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  seq += 1;
  const subteam = over.subteam ?? AERO;
  return {
    id: `t${seq}`,
    project_id: "p1",
    subteam_id: subteam.id,
    subsystem_id: over.subsystem?.id ?? null,
    parent_task_id: null,
    title: `Task ${seq}`,
    description: null,
    type: "part",
    status: "not_started",
    priority: "medium",
    owner_id: over.owner?.id ?? null,
    start_date: null,
    due_date: null,
    estimate_days: null,
    mrl: null,
    on_critical_path: false,
    subteam,
    subteams: [subteam],
    subsystem: over.subsystem ?? null,
    owner: over.owner ?? null,
    ...over,
  };
}

describe("groupTasks", () => {
  test("groups by status in canonical order with status colors, only non-empty", () => {
    const tasks = [
      makeTask({ status: "done" }),
      makeTask({ status: "done" }),
      makeTask({ status: "in_progress" }),
    ];
    const { buckets, total } = groupTasks(tasks, "status");
    expect(total).toBe(3);
    // Canonical order: in_progress comes before done in TASK_STATUSES.
    expect(buckets.map((b) => b.key)).toEqual(
      TASK_STATUSES.filter((s) => s === "in_progress" || s === "done"),
    );
    const done = buckets.find((b) => b.key === "done")!;
    expect(done.count).toBe(2);
    expect(done.color).toBe(STATUS_FILL.done);
  });

  test("dynamic dimensions (owner) sort by count desc", () => {
    const tasks = [
      makeTask({ owner: ANA }),
      makeTask({ owner: ANA }),
      makeTask({ owner: BEN }),
      makeTask({}), // unassigned
    ];
    const { buckets } = groupTasks(tasks, "owner");
    expect(buckets[0]!.label).toBe("Ana");
    expect(buckets[0]!.count).toBe(2);
    expect(buckets.find((b) => b.key === "__none__")!.label).toBe("Unassigned");
  });

  test("mrl buckets and 'No MRL'", () => {
    const { buckets } = groupTasks([makeTask({ mrl: 3 }), makeTask({ mrl: null })], "mrl");
    expect(buckets.map((b) => b.label)).toEqual(["MRL 3", "No MRL"]);
  });
});

describe("filterSet", () => {
  test("open excludes done", () => {
    const tasks = [makeTask({ status: "done" }), makeTask({ status: "blocked" })];
    expect(filterSet(tasks, "open", 14)).toHaveLength(1);
  });

  test("due_window keeps in-window (incl. done), drops overdue and far-future", () => {
    const tasks = [
      makeTask({ due_date: iso(3) }), // in window
      makeTask({ due_date: iso(3), status: "done" }), // in window, done included
      makeTask({ due_date: iso(-2) }), // overdue → excluded
      makeTask({ due_date: iso(40) }), // beyond window
      makeTask({ due_date: null }), // no date
    ];
    expect(filterSet(tasks, "due_window", 14)).toHaveLength(2);
  });

  test("all keeps everything", () => {
    const tasks = [makeTask({}), makeTask({ status: "done" })];
    expect(filterSet(tasks, "all", 14)).toHaveLength(2);
  });
});

describe("computeMetric", () => {
  test("completion ratio + tone", () => {
    const tasks = [
      makeTask({ status: "done" }),
      makeTask({ status: "done" }),
      makeTask({ status: "done" }),
      makeTask({ status: "in_progress" }),
    ];
    const r = computeMetric(tasks, "completion");
    expect(r.value).toBe("75%");
    expect(r.ratio).toBeCloseTo(0.75);
    expect(r.tone).toBe("good");
  });

  test("overdue counts only open past-due", () => {
    const tasks = [
      makeTask({ due_date: iso(-1) }), // overdue open
      makeTask({ due_date: iso(-1), status: "done" }), // done, not counted
      makeTask({ due_date: iso(5) }),
    ];
    const r = computeMetric(tasks, "overdue");
    expect(r.value).toBe("1");
    expect(r.tone).toBe("bad");
  });

  test("blocked tone good when zero", () => {
    expect(computeMetric([makeTask({})], "blocked").tone).toBe("good");
  });
});

describe("subteamStats", () => {
  test("aggregates per subteam and sorts by completion", () => {
    const tasks = [
      makeTask({ subteam: AERO, status: "done" }),
      makeTask({ subteam: AERO, status: "in_progress", due_date: iso(-3) }), // overdue
      makeTask({ subteam: CHASSIS, status: "done" }),
      makeTask({ subteam: CHASSIS, status: "done" }),
    ];
    const stats = subteamStats(tasks);
    expect(stats[0]!.name).toBe("Chassis"); // 100% completion sorts first
    expect(stats[0]!.completion).toBe(1);
    const aero = stats.find((s) => s.id === "st-aero")!;
    expect(aero.total).toBe(2);
    expect(aero.overdue).toBe(1);
    expect(aero.open).toBe(1);
  });
});

describe("workloadByOwner", () => {
  test("count vs estimate measures", () => {
    const tasks = [
      makeTask({ owner: ANA, estimate_days: 2 }),
      makeTask({ owner: ANA, estimate_days: 3 }),
      makeTask({ owner: BEN, estimate_days: 10 }),
    ];
    const byCount = workloadByOwner(tasks, "count");
    expect(byCount.rows[0]!.label).toBe("Ana"); // 2 tasks
    expect(byCount.max).toBe(2);

    const byEst = workloadByOwner(tasks, "estimate");
    expect(byEst.rows[0]!.label).toBe("Ben"); // 10 estimate-days
    expect(byEst.max).toBe(10);
  });

  test("drops zero-load owners", () => {
    const { rows } = workloadByOwner([makeTask({ owner: ANA, estimate_days: null })], "estimate");
    expect(rows).toHaveLength(0);
  });
});
