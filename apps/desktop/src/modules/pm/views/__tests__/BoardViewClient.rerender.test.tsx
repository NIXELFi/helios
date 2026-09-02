import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Subteam, TaskRow, User } from "@helios/pm-ui";

// Card calls taskOutline exactly once per render, so counting the calls counts
// the cards React actually re-rendered.
const outlineCalls = vi.fn();
vi.mock("@helios/pm-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@helios/pm-ui")>();
  return {
    ...actual,
    taskOutline: (...args: Parameters<typeof actual.taskOutline>) => {
      outlineCalls();
      return actual.taskOutline(...args);
    },
  };
});

// Column calls useDroppable exactly once per render, so counting the calls
// counts the columns React actually re-rendered.
const droppableCalls = vi.fn();
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDroppable: (...args: Parameters<typeof actual.useDroppable>) => {
      droppableCalls();
      return actual.useDroppable(...args);
    },
  };
});

const { PmRouterProvider } = await import("@pm/lib/router");
const { usePmStore } = await import("@pm/lib/pmStore");
const { BoardViewClient } = await import("../BoardViewClient");

const uuid = (n: number, tag: string) =>
  `${tag.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const TASK_COUNT = 40;

function seed() {
  const subteams: Subteam[] = Array.from({ length: 4 }, (_, i) => ({
    id: uuid(i, "st"), name: `Subteam ${i}`, code: `S${i}`,
    slug: `subteam-${i}`, color: "#889", icon: null,
  }));
  const users = Array.from({ length: 6 }, (_, i) => ({
    id: uuid(i, "us"), name: `User ${i}`, email: `u${i}@asu.edu`,
  })) as unknown as User[];
  const statuses = ["not_started", "in_progress", "needs_review", "blocked", "done"] as const;
  const tasks = Array.from({ length: TASK_COUNT }, (_, i) => {
    const st = subteams[i % subteams.length]!;
    const u = users[i % users.length]!;
    return {
      id: uuid(i, "ta"), project_id: uuid(0, "pr"), subteam_id: st.id,
      subsystem_id: null, parent_task_id: null, title: `Task ${i}`,
      description: null, type: "part", status: statuses[i % statuses.length]!,
      priority: "medium", owner_id: u.id, start_date: null, due_date: null,
      estimate_days: null, mrl: null, on_critical_path: false, created_by: null,
      subteam: st, subteams: [st], subsystem: null, owner: u, owners: [u],
    } as unknown as TaskRow;
  });
  usePmStore.setState({
    hydrated: true, projectId: uuid(0, "pr"), activeProjectId: uuid(0, "pr"),
    tasks, subteams, users, subsystems: [], dependencies: [],
    selectedTaskIds: new Set<string>(),
  } as never);
  return tasks;
}

function renderBoard() {
  return render(
    <PmRouterProvider initialPath="/board">
      <BoardViewClient teamSlug={null} />
    </PmRouterProvider>,
  );
}

beforeEach(() => {
  outlineCalls.mockClear();
  droppableCalls.mockClear();
});
afterEach(() => {
  cleanup();
  act(() => usePmStore.getState().clearSelection());
});

describe("BoardViewClient re-render cost", () => {
  it("renders every card exactly once on mount", () => {
    seed();
    renderBoard();
    expect(outlineCalls).toHaveBeenCalledTimes(TASK_COUNT);
  });

  // The board used to hand each card a freshly-allocated onToggleSelect/onOpen
  // closure and rebuild its filters from a new URLSearchParams every render, so
  // ticking ONE checkbox re-rendered all of them — the dominant cost of every
  // board interaction on a slow machine.
  it("re-renders only the toggled card when the selection changes", () => {
    const tasks = seed();
    renderBoard();
    outlineCalls.mockClear();

    act(() => usePmStore.getState().toggleSelected(tasks[0]!.id));
    expect(outlineCalls).toHaveBeenCalledTimes(1);

    outlineCalls.mockClear();
    act(() => usePmStore.getState().toggleSelected(tasks[7]!.id));
    expect(outlineCalls).toHaveBeenCalledTimes(1);
  });

  // Review of the first cut: the columns were handed the store's selection Set,
  // which toggleSelected replaces on every click — so the card-level count above
  // passed while all five Column bodies re-ran and re-mapped every task.
  it("re-renders no column when the selection changes", () => {
    const tasks = seed();
    renderBoard();
    droppableCalls.mockClear();

    act(() => usePmStore.getState().toggleSelected(tasks[0]!.id));
    expect(droppableCalls).not.toHaveBeenCalled();
  });

  it("re-renders no cards when an unrelated slice of the store changes", () => {
    seed();
    renderBoard();
    outlineCalls.mockClear();
    droppableCalls.mockClear();
    act(() => usePmStore.setState({ inFlightWrites: 3 } as never));
    expect(outlineCalls).not.toHaveBeenCalled();
    expect(droppableCalls).not.toHaveBeenCalled();
  });
});
