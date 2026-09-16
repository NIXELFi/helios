import { describe, expect, it } from "vitest";
import { summarizeAttention, localDateKey } from "../src/lib/pm-attention";

describe("summarizeAttention", () => {
  const me = "u-me";
  it("counts only my open tasks, split into due-today and overdue", () => {
    const rows = [
      { id: "1", title: "a", due_date: "2026-09-16", status: "in_progress", owner_id: me },
      { id: "2", title: "b", due_date: "2026-09-10", status: "blocked", owner_id: "other", task_owners: [{ owner_id: me }] },
      { id: "3", title: "c", due_date: "2026-09-01", status: "done", owner_id: me },
      { id: "4", title: "d", due_date: "2026-09-16", status: "not_started", owner_id: "other" },
      { id: "5", title: "e", due_date: null, status: "not_started", owner_id: me },
      { id: "6", title: "f", due_date: "2026-09-20", status: "not_started", owner_id: me },
    ];
    expect(summarizeAttention(rows, me, "2026-09-16")).toEqual({ dueToday: 1, overdue: 1 });
  });
  it("localDateKey is a zero-padded local calendar date", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
