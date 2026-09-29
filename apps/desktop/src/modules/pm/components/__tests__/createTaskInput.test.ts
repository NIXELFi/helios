import { describe, expect, test } from "vitest";
import { TASK_TYPES } from "@helios/pm-ui";
import { createTaskInput } from "../CreateTaskDialog";

// Regression: createTaskInput used to hardcode its own type enum, which drifted
// from the shared taskType when the mfg_* types were added — making MFG types
// unselectable in the create-task / create-subtask dialog.
describe("createTaskInput", () => {
  const base = {
    title: "Weld bracket",
    status: "not_started",
    subteam_id: "11111111-1111-4111-8111-111111111111",
    subsystem_id: null,
    owner_id: null,
    start_date: null,
    due_date: null,
    priority: "medium",
    estimate_days: null,
    mrl: null,
    description: null,
  };

  test.each(TASK_TYPES)("accepts shared task type %s", (type) => {
    expect(createTaskInput.safeParse({ ...base, type }).success).toBe(true);
  });

  test("rejects an unknown task type", () => {
    expect(createTaskInput.safeParse({ ...base, type: "bogus" }).success).toBe(false);
  });

  // A date input can still hold a partial year (0202-...) at submit time.
  test("rejects partial-year start and due dates", () => {
    const ok = { ...base, type: "general" };
    expect(createTaskInput.safeParse({ ...ok, start_date: "0202-08-18" }).success).toBe(false);
    expect(createTaskInput.safeParse({ ...ok, due_date: "0020-08-18" }).success).toBe(false);
    expect(createTaskInput.safeParse({ ...ok, start_date: "2026-08-18", due_date: "2026-09-01" }).success).toBe(true);
  });

  test("rejects a due date before the start", () => {
    const r = createTaskInput.safeParse({
      ...base,
      type: "general",
      start_date: "2026-09-01",
      due_date: "2026-08-18",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["due_date"]);
  });

  test("rejects an estimate over ten years", () => {
    expect(createTaskInput.safeParse({ ...base, type: "general", estimate_days: 3651 }).success).toBe(false);
  });
});
