import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Subteam } from "@helios/pm-ui";
import { EventDialog } from "@pm/components/EventDialog";
import { MilestoneDialog } from "@pm/components/MilestoneDialog";
import { BulkActionBar } from "@pm/components/BulkActionBar";
import { usePmStore } from "@pm/lib/pmStore";

// A date input can still hold a partial year (0202-...) when Save is pressed.
// The submit-only dialogs must refuse it rather than save a date that stretches
// every timeline back to year 202.

afterEach(cleanup);

describe("MilestoneDialog", () => {
  test("won't save a partial year and says why", () => {
    const onSave = vi.fn();
    render(<MilestoneDialog open onClose={() => {}} onSave={onSave} projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Design review" } });
    const date = screen.getByLabelText("Target date");
    fireEvent.change(date, { target: { value: "0202-08-18" } });

    const save = screen.getByRole("button", { name: "Save milestone" });
    expect(save).toBeDisabled();
    expect(screen.getByText(/Enter a year between 2000 and 2100/)).toBeInTheDocument();

    fireEvent.change(date, { target: { value: "2026-08-18" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ target_date: "2026-08-18" }));
  });
});

describe("EventDialog", () => {
  function setup() {
    const onSave = vi.fn();
    render(
      <EventDialog open onClose={() => {}} onSave={onSave} projectId="p1" subteams={[] as Subteam[]} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Event name…"), { target: { value: "Shop day" } });
    return { onSave, save: screen.getByRole("button", { name: "Save event" }) };
  }

  test("won't save a partial-year date", () => {
    const { onSave, save } = setup();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "0202-08-18" } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  test("won't save a partial-year or backwards recurrence end", () => {
    const { save } = setup();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-08-18" } });
    fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "weekly" } });
    const end = screen.getByLabelText("Ends (optional)");
    fireEvent.change(end, { target: { value: "0202-01-01" } });
    expect(save).toBeDisabled();
    fireEvent.change(end, { target: { value: "2026-08-01" } });
    expect(save).toBeDisabled();
    expect(screen.getByText("Ends before the start date")).toBeInTheDocument();
    fireEvent.change(end, { target: { value: "2026-12-01" } });
    expect(save).toBeEnabled();
  });
});

describe("BulkActionBar — Due", () => {
  test("a partial year is not written to every selected task", () => {
    const bulkUpdateTasks = vi.fn();
    usePmStore.setState({
      projectId: "p1",
      activeProjectId: "p1",
      currentUserId: "u1",
      projectRoles: { p1: "admin" },
      tasks: [],
      subteams: [],
      subsystems: [],
      users: [],
      selectedTaskIds: new Set<string>(["t1", "t2"]),
      bulkUpdateTasks,
    } as never);
    render(<BulkActionBar />);
    const due = screen.getByLabelText("Set due date for selected tasks");
    fireEvent.change(due, { target: { value: "0202-08-18" } });
    fireEvent.blur(due);
    expect(bulkUpdateTasks).not.toHaveBeenCalled();
    fireEvent.change(due, { target: { value: "2026-08-18" } });
    fireEvent.blur(due);
    expect(bulkUpdateTasks).toHaveBeenCalledWith(["t1", "t2"], { due_date: "2026-08-18" });
  });
});
