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
});
