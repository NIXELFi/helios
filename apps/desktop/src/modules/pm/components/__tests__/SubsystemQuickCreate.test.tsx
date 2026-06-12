import { describe, expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Subteam } from "@helios/pm-ui";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { usePmStore } from "@pm/lib/pmStore";

const SUBTEAM: Subteam = { id: "11111111-1111-4111-8111-111111111111", name: "Aero", code: "AE", slug: "aero", color: null } as Subteam;
const SUBSYS = { id: "22222222-2222-4222-8222-222222222222", subteam_id: SUBTEAM.id, parent_subsystem_id: null, name: "Wing", code: "WIN", color: null } as never;

function noopClient() {
  const chain = {
    insert: () => ({ then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) }),
  };
  return { schema: () => ({ from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) }) } as any;
}

beforeEach(() => {
  usePmStore.setState({
    client: noopClient(),
    projectId: "p1",
    currentUserId: "u1",
    tasks: [],
    subteams: [SUBTEAM],
    subsystems: [SUBSYS],
    users: [],
    dependencies: [],
    activity: [],
    lastWriteError: null,
    selectedTaskIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
  });
});

describe("CreateTaskDialog → + New subsystem…", () => {
  test("opens the quick-create dialog and creating selects the new subsystem (no crash)", async () => {
    render(
      <CreateTaskDialog
        open
        onClose={() => {}}
        onCreate={() => {}}
        projectId="p1"
        subteams={[SUBTEAM]}
        subsystems={[SUBSYS]}
        users={[]}
      />,
    );
    // Open the Subsystem picker.
    fireEvent.click(screen.getByLabelText("Subsystem"));
    // Choose the "+ New subsystem…" entry.
    fireEvent.click(await screen.findByText("+ New subsystem…"));
    // Quick-create dialog appears with the subteam context.
    expect(await screen.findByLabelText("Subsystem name")).toBeInTheDocument();
    // Name it and create.
    fireEvent.change(screen.getByLabelText("Subsystem name"), { target: { value: "Uprights" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    // The new subsystem landed in the store.
    expect(usePmStore.getState().subsystems.some((s) => s.name === "Uprights")).toBe(true);
  });
});
