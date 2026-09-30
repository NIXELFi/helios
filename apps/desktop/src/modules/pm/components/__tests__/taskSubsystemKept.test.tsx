import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Subsystem, Subteam, TaskRow } from "@helios/pm-ui";
import { TaskDetailSheet } from "@pm/components/TaskDetailSheet";
import { usePmStore } from "@pm/lib/pmStore";

// Regression: opening a task cleared its subsystem whenever that subsystem
// wasn't in the task subteam's list. Sharing a subsystem into another subteam
// lives in per-device localStorage, so on any other machine a shared subsystem
// looked foreign and merely OPENING the task wiped it. The reset now happens
// only when the user explicitly changes the primary subteam.

const PROJECT = "p1";
const AERO = { id: "11111111-1111-4111-8111-111111111111", name: "Aero", code: "AE", slug: "aero", color: null } as Subteam;
const SUSP = { id: "33333333-3333-4333-8333-333333333333", name: "Suspension", code: "SU", slug: "suspension", color: null } as Subteam;
const CHAS = { id: "44444444-4444-4444-8444-444444444444", name: "Chassis", code: "CH", slug: "chassis", color: null } as Subteam;
// Wing is owned by AERO; on the machine that shared it, it is also in SUSP.
const WING = {
  id: "22222222-2222-4222-8222-222222222222",
  subteam_id: AERO.id,
  parent_subsystem_id: null,
  name: "Wing",
  code: "WIN",
  color: null,
} as Subsystem;

const TASK_ID = "55555555-5555-4555-8555-555555555555";
const task = {
  id: TASK_ID, project_id: PROJECT, subteam_id: SUSP.id, subsystem_id: WING.id,
  parent_task_id: null, title: "Wing mount", description: null, type: "part",
  status: "in_progress", priority: "medium", owner_id: null, start_date: null,
  due_date: null, estimate_days: null, mrl: null, on_critical_path: false,
  created_by: null, subteam: SUSP, subteams: [SUSP, AERO, CHAS], subsystem: WING,
  owner: null, owners: [],
} as unknown as TaskRow;

const updateTask = vi.fn();

beforeEach(() => {
  localStorage.clear();
  updateTask.mockReset();
  usePmStore.setState({
    projectId: PROJECT,
    activeProjectId: PROJECT,
    currentUserId: "u1",
    projectRoles: { [PROJECT]: "admin" },
    tasks: [task],
    subteams: [AERO, SUSP, CHAS],
    subsystems: [WING],
    users: [],
    dependencies: [],
    comments: [],
    links: [],
    selectedTaskId: TASK_ID,
    updateTask,
    // Stand-in for the real promotion: flip the primary in the store only.
    setPrimarySubteam: (taskId: string, subteamId: string) =>
      usePmStore.setState((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, subteam_id: subteamId } : t)),
      })),
  } as never);
});
afterEach(cleanup);

describe("TaskDetailSheet — subsystem is never cleared on open", () => {
  test("opening a task whose subsystem isn't shared on this device keeps it", () => {
    render(<TaskDetailSheet />);
    expect(updateTask).not.toHaveBeenCalled();
    // The picker still shows the task's real subsystem instead of "—".
    expect(screen.getByLabelText("Subsystem")).toHaveTextContent("Wing");
  });

  test("promoting the subsystem's own subteam keeps the subsystem", () => {
    render(<TaskDetailSheet />);
    act(() => {
      fireEvent.click(screen.getByLabelText("Set Aero as primary subteam"));
    });
    expect(updateTask).not.toHaveBeenCalled();
  });

  test("promoting an unrelated subteam clears the subsystem", () => {
    render(<TaskDetailSheet />);
    act(() => {
      fireEvent.click(screen.getByLabelText("Set Chassis as primary subteam"));
    });
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { subsystem_id: null });
  });
});

describe("TaskDetailSheet — estimate", () => {
  const estimate = () => screen.getByLabelText("Estimate (days)");

  test("saves once on blur, not per keystroke", () => {
    render(<TaskDetailSheet />);
    const input = estimate();
    for (const v of ["1", "12", "12.5"]) fireEvent.change(input, { target: { value: v } });
    expect(updateTask).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { estimate_days: 12.5 });
  });

  test("rejects negative and absurd estimates", () => {
    render(<TaskDetailSheet />);
    const input = estimate() as HTMLInputElement;
    for (const v of ["-3", "3651", "1e9"]) {
      fireEvent.change(input, { target: { value: v } });
      fireEvent.blur(input);
      expect(input.value).toBe("");
    }
    expect(updateTask).not.toHaveBeenCalled();
  });
});
