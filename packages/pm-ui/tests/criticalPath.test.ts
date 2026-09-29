import { describe, it, expect } from "vitest";
import { computeCriticalPath } from "../src/criticalPath";

// Two parallel chains into one end task: A -> END and B -> END. Whichever of A
// and B is longer is critical; the other has slack.
function task(
  id: string,
  fields: { estimate_days?: number | null; start_date?: string | null; due_date?: string | null } = {},
) {
  return { id, estimate_days: null, start_date: null, due_date: null, ...fields };
}
const deps = [
  { predecessor_id: "A", successor_id: "END" },
  { predecessor_id: "B", successor_id: "END" },
];

describe("computeCriticalPath — implausible input", () => {
  it("ignores a span that starts at a partial year (0202-...)", () => {
    const tasks = [
      task("A", { start_date: "0202-08-18", due_date: "2026-08-18" }),
      task("B", { estimate_days: 10 }),
      task("END"),
    ];
    const critical = computeCriticalPath(tasks, deps);
    expect(critical.has("B")).toBe(true);
    expect(critical.has("A")).toBe(false);
  });

  it("clamps durations to ten years", () => {
    const tasks = [
      task("A", { estimate_days: Number.POSITIVE_INFINITY }),
      task("B", { estimate_days: 3650 }),
      task("END"),
    ];
    const critical = computeCriticalPath(tasks, deps);
    // Both clamp to 3650, so both lie on the critical path.
    expect(critical.has("A")).toBe(true);
    expect(critical.has("B")).toBe(true);
  });
});
