import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    status_since: null,
    task_updated_at: null,
    owner_ids: null,
    may_see_actors: null,
    ...over,
  };
}

const FIXTURE: TaskHistoryRow[] = [
  row({ action: "created", task_id: "t1", event_time: isoDaysAgo(20), task_created_at: isoDaysAgo(20), task_status_now: "done" }),
  row({ action: "completed", task_id: "t1", event_time: isoDaysAgo(14), task_created_at: isoDaysAgo(20), task_status_now: "done", due_date: "2020-01-01" }),
  row({ action: "created", task_id: "t2", event_time: isoDaysAgo(10), task_created_at: isoDaysAgo(10), task_status_now: "in_progress", subteam_id: "st-chas", subteam_name: "Chassis" }),
  // The RPC's live snapshot row for the one open task.
  row({ action: "open", task_id: "t2", event_time: isoDaysAgo(10), task_created_at: isoDaysAgo(10), task_status_now: "in_progress", subteam_id: "st-chas", subteam_name: "Chassis" }),
];

function seedStore() {
  usePmStore.setState({
    hydrated: true,
    projectId: PROJECT_ID,
    activeProjectId: PROJECT_ID,
    tasks: [],
    subteams: SUBTEAMS,
    currentUserId: "u-me",
    users: [
      { id: "u-ada", name: "Ada Lovelace", email: null },
      { id: "u-me", name: "Me", email: null },
    ],
    subsystems: [],
    dependencies: [],
    milestones: [],
    selectedTaskId: null,
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

    expect(await screen.findByText("Weeks")).toBeInTheDocument();
    // Measured SVG, not a scaled viewBox: the chart carries a pixel width.
    const chart = screen.getByRole("img", { name: "Tasks completed per week" });
    expect(chart).toHaveAttribute("width");
    expect(chart).not.toHaveAttribute("viewBox");
    expect(screen.getByText("Attention")).toBeInTheDocument();
    // The import-wall metrics are gone for good.
    expect(screen.queryByText("Created vs completed")).not.toBeInTheDocument();
    expect(screen.queryByText("Cycle time")).not.toBeInTheDocument();
    expect(screen.queryByText("Open work aging")).not.toBeInTheDocument();
    // The header reads the live snapshot: one open task, nothing overdue.
    expect(screen.getByText(/completed in window · 1 open · 0 overdue/)).toBeInTheDocument();
    // The KPI row is four linked tiles.
    expect(screen.getByRole("link", { name: "Open completed tasks in the Table" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open tasks due this week in the Table" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open blocked and needs-review tasks in the Table" })).toBeInTheDocument();
  });

  const WORKLOAD_ROWS: TaskHistoryRow[] = [
    row({ action: "open", task_id: "w1", event_time: "x", task_status_now: "in_progress", owner_ids: ["u-ada"], due_date: "2020-01-01" }),
    row({ action: "open", task_id: "w2", event_time: "x", task_status_now: "in_progress", owner_ids: ["u-ada"] }),
    row({ action: "open", task_id: "w3", event_time: "x", task_status_now: "not_started", owner_ids: ["u-me"] }),
    row({ action: "open", task_id: "w4", event_time: "x", task_status_now: "not_started", owner_ids: null }),
  ];

  it("shows only the caller's own row and Unowned when the server gated the actors out", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: WORKLOAD_ROWS.map((r) => ({ ...r, may_see_actors: false })),
      failure: null,
      message: null,
    });
    renderView();

    expect(await screen.findByText("Workload")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Me you$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Unowned" })).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByText(/1 other person's row is hidden/)).toBeInTheDocument();
    // The Team/Person toggle is not offered either.
    expect(screen.queryByRole("radiogroup", { name: "Stack by" })).not.toBeInTheDocument();
  });

  it("shows everyone's workload, most loaded first, when the server says the caller may see actors", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: WORKLOAD_ROWS.map((r) => ({ ...r, may_see_actors: true })),
      failure: null,
      message: null,
    });
    renderView();

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    const bars = screen.getAllByRole("img", { name: /^(Ada Lovelace|Me|Unowned):/ });
    expect(bars[0]).toHaveAccessibleName(/^Ada Lovelace:/);
    expect(screen.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href")).toBe("/table?owner=u-ada");
    expect(screen.getByRole("link", { name: "Unowned" }).getAttribute("href")).toBe("/table?owner=__unassigned__");
    expect(screen.getByRole("radiogroup", { name: "Stack by" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Person" })).toBeInTheDocument();
  });

  it("says so when a pre-v3 server sends no owners", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView();
    expect(await screen.findByText(/Workload needs the latest server update/)).toBeInTheDocument();
  });

  it("renders the not-available notice when the migration is missing", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: [],
      failure: "unavailable",
      message: "function pm.task_history does not exist",
    });
    renderView();

    expect(await screen.findByText(/isn.t available on this server yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Weeks")).not.toBeInTheDocument();
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

  it("renders the subteam picker as the house Select, never a native <select>", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    const { container } = renderView(null);

    const trigger = await screen.findByRole("button", { name: "Subteam" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(container.querySelector("select")).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "All subteams" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Aero" })).toBeInTheDocument();
  });

  it("queries project-wide with a null subteam at project scope", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView(null);

    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    const q = fetchTaskHistory.mock.calls[0]![1] as { subteamId: string | null };
    expect(q.subteamId).toBeNull();
  });
  it("starts the season-to-date window on JUNE 1, not the academic year", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView();
    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    fetchTaskHistory.mockClear();

    fireEvent.click(screen.getByRole("radio", { name: "Season" }));

    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    const now = new Date();
    const seasonYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
    const june1 = new Date(seasonYear, 5, 1);
    // The selected window starts on June 1 of the running season...
    expect(screen.getByLabelText("Selected window")).toHaveTextContent(/^Jun 1 –/);
    // ...and the pull behind it reaches at least that far back (it also covers
    // the previous window for the deltas, so it may start earlier).
    const q = fetchTaskHistory.mock.calls[0]![1] as { from: Date; to: Date };
    expect(q.from.getTime()).toBeLessThanOrEqual(june1.getTime());
    expect(q.to.getTime()).toBeGreaterThanOrEqual(now.getTime() - 1000);
  });

  it("defaults to THIS WEEK — Monday of the current ISO week to now", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView();
    await waitFor(() => expect(fetchTaskHistory).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "This week" })).toHaveAttribute("aria-checked", "true");
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const mondayLabel = monday.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(screen.getByLabelText("Selected window")).toHaveTextContent(`${mondayLabel} –`);
    // The pull reaches back past Monday (previous week + sparkline context)
    // and ends now.
    const q = fetchTaskHistory.mock.calls[0]![1] as { from: Date; to: Date };
    expect(q.from.getTime()).toBeLessThanOrEqual(monday.getTime());
    expect(q.to.getTime()).toBeGreaterThanOrEqual(now.getTime() - 1000);
  });

  it("links every KPI tile into the Table with the matching filters", async () => {
    const today = new Date();
    const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    fetchTaskHistory.mockResolvedValue({
      rows: [
        row({ action: "open", task_id: "d1", event_time: "x", task_status_now: "in_progress", due_date: dayKey }),
        row({ action: "open", task_id: "b1", event_time: "x", task_status_now: "blocked", due_date: "2020-01-01" }),
      ],
      failure: null,
      message: null,
    });
    renderView(null);

    const due = await screen.findByRole("link", { name: "Open tasks due this week in the Table" });
    const href = due.getAttribute("href") ?? "";
    expect(href.startsWith("/table?")).toBe(true);
    const params = new URLSearchParams(href.slice("/table?".length));
    expect(params.get("status")).toBe("not_started,in_progress,blocked,needs_review");
    expect(params.get("from")).toBe(dayKey);
    expect(params.get("to")).not.toBeNull();
    expect(due).toHaveTextContent("1");

    const stuck = screen.getByRole("link", { name: "Open blocked and needs-review tasks in the Table" });
    expect(stuck.getAttribute("href")).toBe("/table?status=blocked%2Cneeds_review");
    expect(stuck).toHaveTextContent("1 blocked");
    expect(screen.getByText(/1 already overdue/)).toBeInTheDocument();
  });

  it("lists attention items, opens a task on click and links each heading to the Table", async () => {
    const twentyDaysAgo = isoDaysAgo(20);
    fetchTaskHistory.mockResolvedValue({
      rows: [
        row({ action: "open", task_id: "b1", event_time: "x", task_title: "Diff mount", task_status_now: "blocked", status_since: twentyDaysAgo, task_updated_at: twentyDaysAgo }),
        row({ action: "open", task_id: "o1", event_time: "x", task_title: "Front wing mould", task_status_now: "not_started", due_date: "2020-01-01", status_since: twentyDaysAgo, task_updated_at: twentyDaysAgo, subteam_id: "st-chas", subteam_name: "Chassis" }),
      ],
      failure: null,
      message: null,
    });
    renderView(null);

    const blocked = await screen.findByRole("region", { name: "Blocked" });
    expect(blocked).toHaveTextContent("Diff mount");
    expect(blocked).toHaveTextContent("20 d");
    const overdue = screen.getByRole("region", { name: "Overdue" });
    expect(overdue).toHaveTextContent("Front wing mould");
    expect(overdue).toHaveTextContent("CH"); // subteam code chip
    const heading = overdue.querySelector("a")!;
    const params = new URLSearchParams((heading.getAttribute("href") ?? "").split("?")[1]);
    expect(params.get("status")).toBe("not_started,in_progress,blocked,needs_review");
    expect(params.get("to")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Diff mount/ }));
    expect(usePmStore.getState().selectedTaskId).toBe("b1");
  });

  it("compares subteams stuck-first with a status bar and a Table link per row", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: [
        row({ action: "open", task_id: "a1", event_time: "x", task_status_now: "in_progress" }),
        row({ action: "open", task_id: "c1", event_time: "x", task_status_now: "blocked", subteam_id: "st-chas", subteam_name: "Chassis" }),
        row({ action: "open", task_id: "c2", event_time: "x", task_status_now: "not_started", subteam_id: "st-chas", subteam_name: "Chassis" }),
      ],
      failure: null,
      message: null,
    });
    renderView(null);

    expect(await screen.findByText("Subteams")).toBeInTheDocument();
    const rows_ = screen.getAllByRole("img", { name: /^(Aero|Chassis):/ });
    // Chassis has the stuck task, so it leads.
    expect(rows_[0]).toHaveAccessibleName(/^Chassis: 0 Done, 0 In Progress, 0 Needs Review, 1 Blocked, 1 Not Started/);
    const link = screen.getByRole("link", { name: "Chassis" });
    expect(link.getAttribute("href")).toBe("/table?team=st-chas&mode=hide");
  });

  it("draws the store's milestones as diamonds on the Weeks strip and names the next one", async () => {
    const inRange = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const inRangeKey = `${inRange.getFullYear()}-${String(inRange.getMonth() + 1).padStart(2, "0")}-${String(inRange.getDate()).padStart(2, "0")}`;
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const laterKey = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, "0")}-${String(later.getDate()).padStart(2, "0")}`;
    usePmStore.setState({
      milestones: [
        { id: "m1", project_id: PROJECT_ID, name: "PDR", target_date: inRangeKey, type: "design_review", description: null },
        { id: "m2", project_id: PROJECT_ID, name: "CDR", target_date: laterKey, type: "design_review", description: null },
      ],
    } as never);
    fetchTaskHistory.mockResolvedValue({
      rows: [row({ action: "completed", task_id: "t1", event_time: isoDaysAgo(1), task_status_now: "done" })],
      failure: null,
      message: null,
    });
    renderView();

    // The one inside the strip is a focusable marker; the future one is only in the caption.
    expect(await screen.findByRole("img", { name: /^Milestone PDR,/ })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /^Milestone CDR,/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Next: CDR in 40 d/)).toBeInTheDocument();
  });

  it("pads the Weeks strip to eight columns on a one-week window and fades the context", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: [row({ action: "completed", task_id: "t1", event_time: isoDaysAgo(1), task_status_now: "done" })],
      failure: null,
      message: null,
    });
    renderView();

    await screen.findByText("Weeks");
    const columns = screen.getAllByRole("img", { name: /^Week of / });
    expect(columns).toHaveLength(8);
    expect(screen.getByText(/Faded weeks are before the window/)).toBeInTheDocument();
    // Keyboard: focusing a column shows its tip.
    fireEvent.focus(columns[7]!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Week of/);
  });

  it("hides the Subteams comparison inside a single subteam's route", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView("aero");
    expect(await screen.findByText("Attention")).toBeInTheDocument();
    expect(screen.queryByText("Subteams")).not.toBeInTheDocument();
  });

  it("carries a picked subteam into the Table links as a hide-others team filter", async () => {
    fetchTaskHistory.mockResolvedValue({ rows: FIXTURE, failure: null, message: null });
    renderView(null);
    fireEvent.click(await screen.findByRole("button", { name: "Subteam" }));
    fireEvent.click(await screen.findByRole("option", { name: "Aero" }));

    const stuck = await screen.findByRole("link", { name: "Open blocked and needs-review tasks in the Table" });
    const params = new URLSearchParams((stuck.getAttribute("href") ?? "").split("?")[1]);
    expect(params.get("team")).toBe("st-aero");
    expect(params.get("mode")).toBe("hide");
  });

  it("disables the export when the window holds only synthetic open rows", async () => {
    fetchTaskHistory.mockResolvedValue({
      rows: [
        row({
          action: "open",
          task_id: "t9",
          event_time: isoDaysAgo(300),
          task_created_at: isoDaysAgo(300),
          task_status_now: "designing",
        }),
      ],
      failure: null,
      message: null,
    });
    renderView();

    // The open task still shows up in the numbers...
    expect(await screen.findByText(/0 completed in window · 1 open/)).toBeInTheDocument();
    // ...but there is no EVENT to export.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });
});
