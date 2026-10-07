import { afterEach, describe, expect, test } from "vitest";
import type { Subsystem, TaskRow } from "@helios/pm-ui";
import {
  moveInGroup,
  recallManualOrder,
  rememberManualOrder,
  taskComparator,
} from "@pm/lib/ganttOrder";
import { DEFAULT_GANTT_SETTINGS, recallGanttSettings, rememberGanttSettings } from "@pm/lib/ganttSettings";

function task(id: string, title: string, extra: Partial<TaskRow> = {}): TaskRow {
  return { id, title, priority: "medium", due_date: null, subsystem_id: null, ...extra } as TaskRow;
}

const ids = (ts: TaskRow[]) => ts.map((t) => t.id);
const none = new Set<string>();

afterEach(() => localStorage.clear());

describe("taskComparator", () => {
  test("alpha sorts by title, numeric-aware and case-insensitive", () => {
    const ts = [task("a", "Upright 10"), task("b", "upright 2"), task("c", "Bellcrank")];
    expect(ids(ts.sort(taskComparator("alpha", none)))).toEqual(["c", "b", "a"]);
  });

  test("criticality ties fall back to title so the order is stable", () => {
    const ts = [task("a", "Zeta"), task("b", "Alpha"), task("c", "Mid", { priority: "critical" })];
    expect(ids(ts.sort(taskComparator("criticality", none)))).toEqual(["c", "b", "a"]);
  });

  test("subsystem groups by subsystem name, unassigned last", () => {
    const subsystems = [
      { id: "s1", name: "Uprights" },
      { id: "s2", name: "A-arms" },
    ] as Subsystem[];
    const ts = [
      task("a", "No home"),
      task("b", "Upright CNC", { subsystem_id: "s1" }),
      task("c", "Lower arm", { subsystem_id: "s2" }),
      task("d", "Front arm", { subsystem_id: "s2" }),
    ];
    expect(ids(ts.sort(taskComparator("subsystem", none, subsystems)))).toEqual(["d", "c", "b", "a"]);
  });

  test("manual follows the saved order; unsaved tasks go after by title", () => {
    const ts = [task("a", "A"), task("b", "B"), task("c", "C"), task("d", "D")];
    expect(ids(ts.sort(taskComparator("manual", none, [], ["c", "a"])))).toEqual(["c", "a", "b", "d"]);
  });
});

describe("moveInGroup", () => {
  test("moves a task up within its group and ranks the whole group", () => {
    expect(moveInGroup(["x"], ["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b", "x"]);
  });

  test("moving past either end is a no-op", () => {
    expect(moveInGroup(["a"], ["a", "b"], "a", -1)).toEqual(["a"]);
    expect(moveInGroup([], ["a", "b"], "b", 1)).toEqual([]);
  });
});

describe("persistence", () => {
  test("manual order round-trips per scope and tolerates junk", () => {
    rememberManualOrder("chassis", ["b", "a"]);
    expect(recallManualOrder("chassis")).toEqual(["b", "a"]);
    expect(recallManualOrder(null)).toEqual([]);
    localStorage.setItem("helios:gantt-order:chassis", "{nope");
    expect(recallManualOrder("chassis")).toEqual([]);
  });

  test("sort mode is remembered with the other Gantt settings", () => {
    rememberGanttSettings(null, { ...DEFAULT_GANTT_SETTINGS, sort: "alpha" });
    expect(recallGanttSettings(null).sort).toBe("alpha");
    localStorage.setItem("helios:gantt:__project__", JSON.stringify({ sort: "bogus" }));
    expect(recallGanttSettings(null).sort).toBe("criticality");
  });
});
