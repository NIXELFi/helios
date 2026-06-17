import { describe, expect, test, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Subsystem, Subteam } from "@helios/pm-ui";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { usePmStore } from "@pm/lib/pmStore";

// Regression for the "Shared Subsystems not working as intended" report (v4.4.1):
// a subsystem whose PRIMARY subteam is A but which is ALSO shared into subteam B
// must be selectable when creating/editing a task under subteam B. The picker
// used to filter on `subteam_id === <chosen>` only, ignoring the sharing map, so
// shared subsystems silently vanished — defeating the share feature.

const AERO: Subteam = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Aero",
  code: "AE",
  slug: "aero",
  color: null,
} as Subteam;
const SUSP: Subteam = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Suspension",
  code: "SU",
  slug: "suspension",
  color: null,
} as Subteam;
// Wing is owned by AERO; it will be shared into SUSP via the sharing map.
const WING: Subsystem = {
  id: "22222222-2222-4222-8222-222222222222",
  subteam_id: AERO.id,
  parent_subsystem_id: null,
  name: "Wing",
  code: "WIN",
  color: null,
} as Subsystem;

function noopClient() {
  const chain = {
    insert: () => ({ then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) }),
  };
  return {
    schema: () => ({ from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) }),
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  usePmStore.setState({
    client: noopClient(),
    projectId: "p1",
    activeProjectId: "p1",
    currentUserId: "u1",
    tasks: [],
    subteams: [AERO, SUSP],
    subsystems: [WING],
    users: [],
    dependencies: [],
    activity: [],
    lastWriteError: null,
    selectedTaskIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
  });
});

describe("CreateTaskDialog — shared subsystems", () => {
  test("a subsystem shared into the chosen subteam is selectable", async () => {
    // Wing (owned by AERO) is shared into SUSP for this project.
    localStorage.setItem(
      "helios:subsystemSharing:p1",
      JSON.stringify({ [WING.id]: [SUSP.id] }),
    );

    render(
      <CreateTaskDialog
        open
        onClose={() => {}}
        onCreate={() => {}}
        projectId="p1"
        subteams={[AERO, SUSP]}
        subsystems={[WING]}
        users={[]}
        defaultSubteamId={SUSP.id}
      />,
    );

    // Open the Subsystem picker; the shared subsystem must appear as an option.
    fireEvent.click(screen.getByLabelText("Subsystem"));
    expect(await screen.findByText("Wing")).toBeInTheDocument();
  });

  test("a subsystem NOT shared into the chosen subteam stays hidden", async () => {
    // No sharing entry: Wing belongs only to AERO, so under SUSP it must not show.
    render(
      <CreateTaskDialog
        open
        onClose={() => {}}
        onCreate={() => {}}
        projectId="p1"
        subteams={[AERO, SUSP]}
        subsystems={[WING]}
        users={[]}
        defaultSubteamId={SUSP.id}
      />,
    );

    fireEvent.click(screen.getByLabelText("Subsystem"));
    // The picker opened (the synthetic "+ New subsystem…" entry is present)…
    expect(await screen.findByText("+ New subsystem…")).toBeInTheDocument();
    // …but Wing is not an option under SUSP.
    expect(screen.queryByText("Wing")).not.toBeInTheDocument();
  });
});
