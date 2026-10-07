import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import type { Workspace } from "../lib/data";
import { usePmStore } from "../lib/pmStore";
import { loadWorkspace } from "../lib/data";
import { saveSnapshot } from "../lib/workspace-snapshot";
import { PmModule } from "../PmModule";

const auth = vi.hoisted(() => ({ user: { id: "alice" }, client: {} }));
vi.mock("@helios/auth", () => ({ useUser: () => auth.user, useSupabaseClientOrNull: () => auth.client }));
vi.mock("../lib/data", () => ({ loadWorkspace: vi.fn() }));
vi.mock("../lib/pm-realtime", () => ({ subscribePmRealtime: () => () => {} }));
// Exercise the production module effects/store; omit unrelated view rendering.
vi.mock("../lib/router", () => ({ PmRouterProvider: () => null, usePathname: () => "/table" }));
vi.mock("../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/TaskDetailSheet", () => ({ TaskDetailSheet: () => null }));
vi.mock("../components/DeadlineReportWindow", () => ({ DeadlineReportWindow: () => null }));
vi.mock("../views/DashboardViewClient", () => ({ DashboardViewClient: () => null }));
vi.mock("../views/TableViewClient", () => ({ TableViewClient: () => null }));
vi.mock("../views/BoardViewClient", () => ({ BoardViewClient: () => null }));
vi.mock("../views/GanttViewClient", () => ({ GanttViewClient: () => null }));
vi.mock("../views/GraphViewClient", () => ({ GraphViewClient: () => null }));
vi.mock("../views/CalendarViewClient", () => ({ CalendarViewClient: () => null }));
vi.mock("../views/ActivityFeedClient", () => ({ ActivityFeedClient: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function workspace(title = "server-old"): Workspace {
  return {
    projects: [{ id: "p1", name: "SDM27", description: null }],
    projectData: { p1: {
      tasks: [{ id: "t1", title } as never], subteams: [], subsystems: [], users: [],
      dependencies: [], milestones: [], pages: [], blocks: [], activity: [], vendors: [],
      comments: [], links: [], buildRecords: [], events: [], hiddenSubteams: [],
    } },
    baselineOrg: { subteams: [], subsystems: [], users: [] }, roles: {},
  };
}

const initial = usePmStore.getInitialState();
beforeEach(() => {
  localStorage.clear();
  vi.mocked(loadWorkspace).mockReset();
  auth.user = { id: "alice" };
  usePmStore.setState(initial, true);
  saveSnapshot(workspace(), "alice", new Date().toISOString());
});
afterEach(cleanup);

test("an in-flight background refresh cannot hydrate after unmount", async () => {
  vi.mocked(loadWorkspace).mockResolvedValueOnce(workspace());
  const pending = deferred<Workspace>();
  vi.mocked(loadWorkspace).mockReturnValueOnce(pending.promise);
  const view = render(<PmModule />);
  await waitFor(() => expect(usePmStore.getState().hydrated).toBe(true));
  await act(async () => {});
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));
  view.unmount();
  usePmStore.setState({ currentUserId: "bob", tasks: [{ id: "b", title: "bob" } as never] });
  await act(async () => { pending.resolve(workspace("alice-response")); });
  expect(usePmStore.getState().currentUserId).toBe("bob");
  expect(usePmStore.getState().tasks[0]!.title).toBe("bob");
});

test("a registered explicit reload cannot hydrate after cleanup", async () => {
  vi.mocked(loadWorkspace).mockResolvedValueOnce(workspace());
  const pending = deferred<Workspace>();
  vi.mocked(loadWorkspace).mockReturnValueOnce(pending.promise);
  const view = render(<PmModule />);
  await act(async () => {});
  const reload = usePmStore.getState().reloadWorkspace!();
  await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));
  view.unmount();
  usePmStore.setState({ currentUserId: "bob" });
  await act(async () => { pending.resolve(workspace()); await reload; });
  expect(usePmStore.getState().currentUserId).toBe("bob");
});

test.each([false, true])("startup discards stale data when a write occurs during fetch (already settled: %s)", async (settled) => {
  const stale = deferred<Workspace>();
  const fresh = deferred<Workspace>();
  vi.mocked(loadWorkspace).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
  render(<PmModule />);
  await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(1));
  act(() => usePmStore.setState({
    tasks: [{ id: "t1", title: "my-edit" } as never], writeEpoch: 1, inFlightWrites: settled ? 0 : 1,
  }));
  await act(async () => { stale.resolve(workspace()); });
  expect(usePmStore.getState().tasks[0]!.title).toBe("my-edit");
  if (!settled) {
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    act(() => usePmStore.setState({ inFlightWrites: 0 }));
  }
  await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));
  await act(async () => { fresh.resolve(workspace("saved-edit")); });
  expect(usePmStore.getState().tasks[0]!.title).toBe("saved-edit");
});

test("scope changes invalidate the previous user's pending response", async () => {
  const alice = deferred<Workspace>();
  vi.mocked(loadWorkspace).mockReturnValueOnce(alice.promise).mockResolvedValueOnce(workspace("bob"));
  const view = render(<PmModule />);
  auth.user = { id: "bob" };
  view.rerender(<PmModule />);
  await waitFor(() => expect(usePmStore.getState().currentUserId).toBe("bob"));
  await act(async () => { alice.resolve(workspace("alice")); });
  expect(usePmStore.getState().tasks[0]!.title).toBe("bob");
});
