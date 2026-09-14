import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Subteam } from "@helios/pm-ui";
import type { TaskHistoryResult, TaskHistoryRow } from "@pm/lib/taskHistory";

// The view is a thin shell over fetchTaskHistory + buildProductivity; the smoke
// test exercises the shell, so the RPC wrapper is the seam we mock.
const fetchTaskHistory = vi.fn<(client: unknown, q: unknown) => Promise<TaskHistoryResult>>();
vi.mock("@pm/lib/taskHistory", () => ({
  fetchTaskHistory: (client: unknown, q: unknown) => fetchTaskHistory(client, q),
}));

// useSupabaseClient throws without an auth provider; the mocked wrapper never
// touches the value, so a sentinel will do — but it MUST be a stable reference.
// The client is an effect dependency, so returning a fresh object per render
// would re-fire the fetch forever.
const STUB_CLIENT = {};
vi.mock("@helios/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@helios/auth")>();
  return { ...actual, useSupabaseClient: () => STUB_CLIENT };
});

const { PmRouterProvider } = await import("@pm/lib/router");
const { usePmStore } = await import("@pm/lib/pmStore");
const { ProductivityViewClient } = await import("../ProductivityViewClient");

const PROJECT_ID = "11111111-0000-4000-8000-000000000001";

const SUBTEAMS: Subteam[] = [
  { id: "st-aero", name: "Aero", code: "AE", slug: "aero", color: "#8C1D40", icon: null },
  { id: "st-chas", name: "Chassis", code: "CH", slug: "chassis", color: "#FFC627", icon: null },
] as unknown as Subteam[];

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

let seq = 0;
function row(over: Partial<TaskHistoryRow> & Pick<TaskHistoryRow, "action" | "task_id" | "event_time">): TaskHistoryRow {
  seq += 1;
  return {
    activity_id: `a${seq}`,
    task_title: "Mount the wing",
    subteam_id: "st-aero",
    subteam_name: "Aero",
    status_from: null,
    status_to: null,
    actor_id: null,
    actor_name: null,
    task_created_at: null,
    due_date: null,
    task_status_now: null,
    estimate_days: null,
    actual_days: null,
    ...over,
  };
}

const FIXTURE: TaskHistoryRow[] = [
  row({ action: "created", task_id: "t1", event_time: isoDaysAgo(20), task_created_at: isoDaysAgo(20), task_status_now: "done" }),
  row({ action: "completed", task_id: "t1", event_time: isoDaysAgo(14), task_created_at: isoDaysAgo(20), task_status_now: "done", due_date: "2020-01-01" }),
  row({ action: "created", task_id: "t2", event_time: isoDaysAgo(10), task_created_at: isoDaysAgo(10), task_status_now: "active", subteam_id: "st-chas", subteam_name: "Chassis" }),
];

function seedStore() {
  usePmStore.setState({
    hydrated: true,
    projectId: PROJECT_ID,
    activeProjectId: PROJECT_ID,
    tasks: [],
    subteams: SUBTEAMS,
    users: [],
    subsystems: [],
    dependencies: [],
    selectedTaskIds: new Set<string>(),
  } as never);
}

function renderView(teamSlug: string | null = null) {
  return render(
    <PmRouterProvider initialPath={teamSlug ? `/team/${teamSlug}/productivity` : "/productivity"}>
      <ProductivityViewClient teamSlug={teamSlug} />
    </PmRouterProvider>,
  );
}

beforeEach(() => {
  fetchTaskHistory.mockReset();
  seedStore();
});
afterEach(cleanup);

describe("ProductivityViewClient", () => {
  it("renders the panels from fixture rows", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView();

    expect(await screen.findByText("Throughput")).toBeInTheDocument();
    expect(screen.getByText("Created vs completed")).toBeInTheDocument();
    expect(screen.getByText("Cycle time")).toBeInTheDocument();
    expect(screen.getByText("On-time rate")).toBeInTheDocument();
    expect(screen.getByText("Open work aging")).toBeInTheDocument();
    // 1 completed, 2 created, 1 open.
    expect(screen.getByText("1 completed · 2 created · 1 open")).toBeInTheDocument();
  });

  it("hides the per-person table and explains why when the RPC returned no actors", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView();

    expect(await screen.findByText("By person")).toBeInTheDocument();
    expect(
      screen.getByText(/only visible to people who can manage this scope/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Median cycle")).not.toBeInTheDocument();
    // The stack-by-person toggle is not offered either.
    expect(screen.queryByText("Stack by person")).not.toBeInTheDocument();
  });

  it("shows the per-person table when actors came back", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: FIXTURE.map((r) => ({ ...r, actor_id: "u1", actor_name: "Ada Lovelace" })),
      failure: null,
      message: null,
    });
    renderView();

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Median cycle")).toBeInTheDocument();
    expect(screen.getByText("Stack by person")).toBeInTheDocument();
  });

  it("renders the not-available notice when the migration is missing", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: [],
      failure: "unavailable",
      message: "function pm.task_history does not exist",
    });
    renderView();

    expect(await screen.findByText(/isn.t available on this server yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Throughput")).not.toBeInTheDocument();
    // Nothing to export.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("renders a retry on a generic failure", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: [], failure: "error", message: "network down" });
    renderView();

    expect(await screen.findByText(/Couldn.t load task history/i)).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders an empty state for a window with no activity", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: [], failure: null, message: null });
    renderView();

    expect(await screen.findByText("No task activity in this window.")).toBeInTheDocument();
  });

  it("scopes the query to the route's subteam and hides the subteam picker", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView("aero");

    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    const q = fetchTaskHistory.mock.calls[0]![1] as { subteamId: string | null; projectId: string };
    expect(q.subteamId).toBe("st-aero");
    expect(q.projectId).toBe(PROJECT_ID);
    expect(screen.queryByLabelText("Subteam")).not.toBeInTheDocument();
    expect(await screen.findByText("Aero · Productivity")).toBeInTheDocument();
  });

  it("queries project-wide with a null subteam at project scope", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView(null);

    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    const q = fetchTaskHistory.mock.calls[0]![1] as { subteamId: string | null };
    expect(q.subteamId).toBeNull();
  });
});
