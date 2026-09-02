import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Subteam, TaskRow, User } from "@helios/pm-ui";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { usePmStore } from "@pm/lib/pmStore";

// "Add Co-Owner feature to 'New Task' menu" (2026-08-26). Co-owners already
// existed on an EXISTING task, but the create form had no field for them, so
// every new task needed a second trip through the detail sheet.

const DAQ: Subteam = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Data Acquisition", code: "DAQ", slug: "daq", color: null,
} as Subteam;
const AERO: Subteam = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Aero", code: "AE", slug: "aero", color: null,
} as Subteam;

const ALEX: User = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alex Rumer", email: null, subteam_ids: [DAQ.id] };
const BO: User = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Bo Nguyen", email: null, subteam_ids: [DAQ.id] };
const CY: User = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Cy Patel", email: null, subteam_ids: [AERO.id] };
const USERS = [ALEX, BO, CY];

beforeEach(() => {
  localStorage.clear();
  usePmStore.setState({
    client: null, projectId: "p1", activeProjectId: "p1", currentUserId: ALEX.id,
    tasks: [], subteams: [DAQ, AERO], subsystems: [], users: USERS,
    dependencies: [], activity: [], lastWriteError: null,
    selectedTaskIds: new Set<string>(), undoStack: [], redoStack: [],
  } as never);
});

function renderDialog(onCreate: (t: TaskRow, extra?: unknown) => void) {
  return render(
    <CreateTaskDialog
      open
      onClose={() => {}}
      onCreate={onCreate}
      projectId="p1"
      subteams={[DAQ, AERO]}
      subsystems={[]}
      users={USERS}
      defaultSubteamId={DAQ.id}
    />,
  );
}

function pick(ariaLabel: string, optionText: string) {
  fireEvent.click(screen.getByLabelText(ariaLabel));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(optionText) }));
}

describe("CreateTaskDialog — co-owners", () => {
  test("staged co-owners ride along in the created task's owners list", async () => {
    const onCreate = vi.fn();
    renderDialog(onCreate);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Wire the DAQ loom" } });
    pick("Owner", "Alex Rumer");
    pick("Add co-owner", "Bo Nguyen");

    // The co-owner shows as a chip with a remove control.
    expect(screen.getByRole("button", { name: "Remove co-owner Bo Nguyen" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    // react-hook-form validates through the zod resolver asynchronously.
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const task = onCreate.mock.calls[0]![0] as TaskRow;
    expect(task.owner_id).toBe(ALEX.id);
    // Primary first, then co-owners — the shape addTask persists.
    expect(task.owners.map((u) => u.id)).toEqual([ALEX.id, BO.id]);
  });

  test("promoting a staged co-owner to primary owner drops the duplicate", async () => {
    const onCreate = vi.fn();
    renderDialog(onCreate);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Loom v2" } });
    pick("Add co-owner", "Bo Nguyen");
    pick("Owner", "Bo Nguyen");

    expect(screen.queryByRole("button", { name: "Remove co-owner Bo Nguyen" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const task = onCreate.mock.calls[0]![0] as TaskRow;
    expect(task.owners.map((u) => u.id)).toEqual([BO.id]);
  });

  test("changing the primary back restores the co-owner it had displaced", async () => {
    // The first cut deleted the promoted co-owner from state; picking a
    // different Owner afterwards left Bo gone for good.
    const onCreate = vi.fn();
    renderDialog(onCreate);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Loom v2" } });
    pick("Add co-owner", "Bo Nguyen");
    pick("Owner", "Bo Nguyen");
    expect(screen.queryByRole("button", { name: "Remove co-owner Bo Nguyen" })).not.toBeInTheDocument();

    pick("Owner", "Alex Rumer");
    expect(screen.getByRole("button", { name: "Remove co-owner Bo Nguyen" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const task = onCreate.mock.calls[0]![0] as TaskRow;
    expect(task.owners.map((u) => u.id)).toEqual([ALEX.id, BO.id]);
  });

  test("the owner picker puts the chosen subteam's people above everyone else", () => {
    renderDialog(vi.fn());
    fireEvent.click(screen.getByLabelText("Owner"));
    const listbox = screen.getAllByRole("listbox")[0]!;
    expect(within(listbox).getByText("Data Acquisition · this subteam")).toBeInTheDocument();
    const labels = within(listbox)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());
    // Unassigned, then the two DAQ members, then the Aero one.
    expect(labels).toEqual(["Unassigned", "Alex Rumer", "Bo Nguyen", "Cy Patel"]);
  });
});
