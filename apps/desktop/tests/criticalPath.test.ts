import { describe, it, expect } from "vitest";
import { computeCriticalPath } from "@helios/pm-ui";

// Minimal task/dep builders — computeCriticalPath only reads id + estimate_days
// + the scheduled dates.
type T = { id: string; estimate_days?: number | null; start_date?: string | null; due_date?: string | null };
const t = (
  id: string,
  estimate_days: number | null = null,
  start_date: string | null = null,
  due_date: string | null = null,
): T => ({ id, estimate_days, start_date, due_date });
const dep = (p: string, s: string) => ({ predecessor_id: p, successor_id: s });

describe("computeCriticalPath", () => {
  it("marks a linear chain entirely critical", () => {
    const c = computeCriticalPath([t("a"), t("b"), t("c")], [dep("a", "b"), dep("b", "c")]);
    expect([...c].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty with NO dependencies (no degenerate 'everything is critical')", () => {
    const c = computeCriticalPath([t("a"), t("b"), t("c")], []);
    expect(c.size).toBe(0);
  });

  it("excludes isolated tasks sitting alongside a real chain", () => {
    const c = computeCriticalPath(
      [t("a"), t("b"), t("c"), t("x")],
      [dep("a", "b"), dep("b", "c")],
    );
    expect(c.has("x")).toBe(false);
    expect(c.has("b")).toBe(true);
  });

  it("follows the longer-DURATION branch, not the longer hop count", () => {
    // root -> (a1 -> a2 -> sink, each 1 day) vs (b1 -> sink, b1 = 10 days)
    const tasks = [t("root", 1), t("a1", 1), t("a2", 1), t("b1", 10), t("sink", 1)];
    const deps = [
      dep("root", "a1"), dep("a1", "a2"), dep("a2", "sink"),
      dep("root", "b1"), dep("b1", "sink"),
    ];
    const c = computeCriticalPath(tasks, deps);
    expect(c.has("b1")).toBe(true);
    expect(c.has("a1")).toBe(false);
    expect(c.has("a2")).toBe(false);
    expect(c.has("root")).toBe(true);
    expect(c.has("sink")).toBe(true);
  });

  it("derives duration from the scheduled date span when no estimate is set", () => {
    const tasks = [
      t("root", 1), t("a1", 1), t("a2", 1),
      t("b1", null, "2026-01-01", "2026-01-11"), // ~10-day window, no estimate
      t("sink", 1),
    ];
    const deps = [
      dep("root", "a1"), dep("a1", "a2"), dep("a2", "sink"),
      dep("root", "b1"), dep("b1", "sink"),
    ];
    const c = computeCriticalPath(tasks, deps);
    expect(c.has("b1")).toBe(true);
    expect(c.has("a1")).toBe(false);
  });

  it("returns empty on a dependency cycle", () => {
    const c = computeCriticalPath([t("a"), t("b")], [dep("a", "b"), dep("b", "a")]);
    expect(c.size).toBe(0);
  });
});
