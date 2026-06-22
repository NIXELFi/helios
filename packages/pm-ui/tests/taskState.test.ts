import { describe, it, expect } from "vitest";
import { taskOutlineState, daysUntilDue } from "../src/taskState";

// ─── regression: setHours() mutation ────────────────────────────────────────
// Both taskOutlineState and daysUntilDue previously called today.setHours(),
// which mutated the caller's Date in-place. After the fix they build a fresh
// midnight Date without touching `today`.

describe("taskOutlineState — does not mutate the `today` argument", () => {
  it("leaves the hour/minute/second of today unchanged", () => {
    const today = new Date(2026, 5, 22, 14, 30, 0, 0); // 2026-06-22 14:30:00
    const original = today.getTime();

    taskOutlineState(
      { status: "in_progress", due_date: "2026-06-25", estimate_days: null },
      today,
    );

    // today must not have been mutated to midnight.
    expect(today.getTime()).toBe(original);
    expect(today.getHours()).toBe(14);
  });

  it("past_due when due_date is before today", () => {
    const today = new Date(2026, 5, 22); // 2026-06-22
    expect(
      taskOutlineState(
        { status: "in_progress", due_date: "2026-06-20", estimate_days: null },
        today,
      ),
    ).toBe("past_due");
  });

  it("done regardless of due_date", () => {
    expect(
      taskOutlineState({ status: "done", due_date: "2020-01-01", estimate_days: null }),
    ).toBe("done");
  });
});

describe("daysUntilDue — does not mutate the `today` argument", () => {
  it("leaves the hour/minute/second of today unchanged", () => {
    const today = new Date(2026, 5, 22, 9, 0, 0, 0); // 2026-06-22 09:00:00
    const original = today.getTime();

    daysUntilDue("2026-06-25", today);

    expect(today.getTime()).toBe(original);
    expect(today.getHours()).toBe(9);
  });

  it("returns null for null input", () => {
    expect(daysUntilDue(null)).toBeNull();
  });

  it("returns correct days for a future date", () => {
    const today = new Date(2026, 5, 22); // 2026-06-22
    expect(daysUntilDue("2026-06-25", today)).toBe(3);
  });

  it("returns 0 for today", () => {
    const today = new Date(2026, 5, 22);
    expect(daysUntilDue("2026-06-22", today)).toBe(0);
  });

  it("returns negative for past date", () => {
    const today = new Date(2026, 5, 22);
    expect(daysUntilDue("2026-06-20", today)).toBe(-2);
  });
});
