import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SupabaseClient } from "@helios/auth";
import type { CalendarEvent, Subteam, TaskRow } from "@helios/pm-ui";
import { BulkActionBar } from "@pm/components/BulkActionBar";
import { usePmStore } from "../pmStore";

// Chainable recorder mock — same slice of supabase-js the write layer uses.
// `error` controls whether every write resolves ok or fails. Each recorded write
// captures the payload + the .eq/.in filters so tests can assert the exact
// reversing writes that undo/redo issue.
interface Write {
  table: string;
  op: string;
  payload?: unknown;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown]>;
}
function recorderClient(error: { message: string } | null = null) {
  const writes: Write[] = [];
  function tbl(table: string) {
    function start(op: string, payload?: unknown) {
      const rec: Write = { table, op, payload, eqs: [], ins: [] };
      const chain = {
        eq(col: string, val: unknown) {
          rec.eqs.push([col, val]);
          return chain;
        },
        in(col: string, vals: unknown) {
          rec.ins.push([col, vals]);
          return chain;
        },
        then<R>(onF: (v: { data: null; error: typeof error }) => R) {
          writes.push(rec);
          return Promise.resolve({ data: null, error }).then(onF);
        },
      };
      return chain;
    }
    return {
      insert: (p?: unknown) => start("insert", p),
      update: (p?: unknown) => start("update", p),
      upsert: (p?: unknown) => start("upsert", p),
      delete: () => start("delete"),
    };
  }
  const client = {
    schema: () => ({ from: (t: string) => tbl(t) }),
  } as unknown as SupabaseClient;
  return { client, writes };
}

const SUBTEAM: Subteam = { id: "st1", name: "Aero", code: "AE", slug: "aero", color: null };
const SUBTEAM2: Subteam = { id: "st2", name: "Chassis", code: "CH", slug: "chassis", color: null };
const SUBSYS1 = { id: "ss1", subteam_id: "st1", name: "Wing", color: null } as never;
const USER1 = { id: "u-alice", name: "Alice" } as never;

function makeTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    project_id: "p1",
    subteam_id: "st1",
    subsystem_id: null,
    parent_task_id: null,
    title: `task ${id}`,
    description: null,
    type: "general",
    status: "not_started",
    priority: "medium",
    owner_id: null,
    start_date: null,
    due_date: null,
    estimate_days: null,
    mrl: null,
    on_critical_path: false,
    subteam: SUBTEAM,
    subsystem: null,
    owner: null,
    ...over,
  } as TaskRow;
}

// Set up a minimal signed-in store backed by the given client.
function seed(client: SupabaseClient, tasks: TaskRow[] = []) {
  usePmStore.setState({
    client,
    projectId: "p1",
    currentUserId: "u1",
    tasks,
    subteams: [SUBTEAM, SUBTEAM2],
    subsystems: [SUBSYS1],
    users: [USER1],
    dependencies: [],
    activity: [],
    lastWriteError: null,
    selectedTaskIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  usePmStore.setState({ lastWriteError: null });
});

describe("optimistic persistence with rollback", () => {
  test("addTask keeps the task and writes to the DB on success", async () => {
    const { client, writes } = recorderClient(null);
    seed(client);
    const task = makeTask("t1");

    usePmStore.getState().addTask(task);
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy();

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy();
    expect(usePmStore.getState().lastWriteError).toBeNull();
    expect(writes.some((w) => w.table === "tasks" && w.op === "insert")).toBe(true);
  });

  test("addTask rolls the new task back and records an error when the write fails", async () => {
    const { client } = recorderClient({ message: "permission denied for table tasks" });
    seed(client);
    const task = makeTask("t1");

    usePmStore.getState().addTask(task);
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy(); // optimistic

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeFalsy(); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/permission denied/i);
  });

  test("updateTask restores the previous task on a failed write", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1")]);

    usePmStore.getState().updateTask("t1", { title: "edited" });
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")?.title).toBe("edited");

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")?.title).toBe("task t1");
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("deleteTask re-adds the task on a failed write", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1")]);

    usePmStore.getState().deleteTask("t1");
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeFalsy(); // optimistic remove

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy(); // restored
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("with no client (not signed in) mutations stay in-memory and never throw", async () => {
    seed(null as unknown as SupabaseClient);
    usePmStore.getState().addTask(makeTask("t1"));
    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy();
    expect(usePmStore.getState().lastWriteError).toBeNull();
  });

  test("deleteEvent removes optimistically and rolls back on a failed write", async () => {
    const { client } = recorderClient({ message: "denied" });
    const ev: CalendarEvent = {
      id: "e1",
      project_id: "p1",
      title: "Comp",
      date: "2026-05-01",
      all_subteams: true,
      subteam_ids: [],
      type_tags: [],
      description: null,
    };
    usePmStore.setState({ client, events: [ev], lastWriteError: null });

    usePmStore.getState().deleteEvent("e1");
    expect(usePmStore.getState().events.find((e) => e.id === "e1")).toBeFalsy(); // optimistic

    await flush();
    expect(usePmStore.getState().events.find((e) => e.id === "e1")).toBeTruthy(); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });
});

// ---------------------------------------------------------------------------
// L2 — bulkUpdateTasks
// ---------------------------------------------------------------------------
describe("bulkUpdateTasks", () => {
  test("applies the patch optimistically to every selected task", () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1"), makeTask("t2"), makeTask("t3")]);

    usePmStore.getState().bulkUpdateTasks(["t1", "t3"], { priority: "high" });

    const byId = (id: string) => usePmStore.getState().tasks.find((t) => t.id === id)!;
    expect(byId("t1").priority).toBe("high");
    expect(byId("t3").priority).toBe("high");
    expect(byId("t2").priority).toBe("medium"); // untouched
  });

  test("writes ONE batched update and rolls ALL tasks back on failure", async () => {
    const { client, writes } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1"), makeTask("t2")]);

    usePmStore.getState().bulkUpdateTasks(["t1", "t2"], { status: "done" });
    expect(usePmStore.getState().tasks.every((t) => t.status === "done")).toBe(true); // optimistic

    await flush();
    expect(usePmStore.getState().tasks.every((t) => t.status === "not_started")).toBe(true); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
    // Exactly one .in()-scoped tasks update for the whole batch.
    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0]!.ins).toEqual([["id", ["t1", "t2"]]]);
  });

  test("appends a SINGLE summarizing activity entry (count), not one per task", () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1"), makeTask("t2"), makeTask("t3")]);
    const before = usePmStore.getState().activity.length;

    usePmStore.getState().bulkUpdateTasks(["t1", "t2", "t3"], { priority: "low" });

    const after = usePmStore.getState().activity;
    expect(after.length).toBe(before + 1);
    expect(after[0]!.action).toBe("updated");
    expect((after[0]!.payload as { count: number }).count).toBe(3);
  });

  test("re-embeds owner/subteam and nulls subsystem when subteam_id changes", () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1", { subsystem_id: "ss1", subsystem: SUBSYS1 })]);

    usePmStore.getState().bulkUpdateTasks(["t1"], { owner_id: "u-alice" });
    expect(usePmStore.getState().tasks[0]!.owner).toMatchObject({ id: "u-alice" });

    // Moving subteams must null + re-embed the subsystem.
    usePmStore.getState().bulkUpdateTasks(["t1"], { subteam_id: "st2" });
    const t = usePmStore.getState().tasks[0]!;
    expect(t.subteam).toMatchObject({ id: "st2" });
    expect(t.subsystem_id).toBeNull();
    expect(t.subsystem).toBeNull();
  });

  test("with no client the bulk change stays in-memory and never throws", async () => {
    seed(null as unknown as SupabaseClient, [makeTask("t1"), makeTask("t2")]);
    usePmStore.getState().bulkUpdateTasks(["t1", "t2"], { priority: "critical" });
    await flush();
    expect(usePmStore.getState().tasks.every((t) => t.priority === "critical")).toBe(true);
    expect(usePmStore.getState().lastWriteError).toBeNull();
  });

  // ISSUE 1 — the bulk bar must intersect the (possibly stale) selection against
  // the active view's selectable id set BEFORE writing, so an atomic .in() write
  // never includes a row that is external / RLS-denied in the current scope
  // (which would roll the whole batch back). This asserts the intersected-ids
  // contract at the store/write layer.
  test("applying with a selection containing a non-selectable id only writes the intersected ids", async () => {
    const { client, writes } = recorderClient(null);
    // t1, t2 are owned/selectable in this view; ext1 is a stale selection from a
    // prior scope and is NOT in the view's selectable set.
    seed(client, [makeTask("t1"), makeTask("t2")]);

    const selectedTaskIds = new Set(["t1", "ext1", "t2"]);
    const selectableIds = new Set(["t1", "t2"]); // what the active view owns
    // Mirror BulkActionBar's intersection exactly.
    const effectiveIds = [...selectedTaskIds].filter((id) => selectableIds.has(id));
    expect(effectiveIds).toEqual(["t1", "t2"]); // ext1 dropped

    usePmStore.getState().bulkUpdateTasks(effectiveIds, { status: "done" });
    await flush();

    expect(usePmStore.getState().lastWriteError).toBeNull();
    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates).toHaveLength(1);
    // The .in() filter carries ONLY the intersected ids — ext1 never reaches the DB.
    expect(taskUpdates[0]!.ins).toEqual([["id", ["t1", "t2"]]]);
  });
});

// ---------------------------------------------------------------------------
// L2b — BulkActionBar intersects selection against the view's selectable set
// (ISSUE 1, end-to-end through the rendered component)
// ---------------------------------------------------------------------------
describe("BulkActionBar selectable-id intersection", () => {
  test("a stale/non-selectable id in the selection is excluded from the bulk write and the count", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1"), makeTask("t2")]);
    // Selection carries a stale id (ext1) that the current view does NOT own.
    usePmStore.setState({ selectedTaskIds: new Set(["t1", "ext1", "t2"]) });

    render(<BulkActionBar selectableIds={new Set(["t1", "t2"])} />);

    // The displayed count reflects the intersection (2), not the raw selection (3).
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    // Commit a due date via blur (ISSUE 5: commit on blur, not every onChange).
    const dueInput = screen.getByLabelText("Set due date for selected tasks");
    fireEvent.change(dueInput, { target: { value: "2026-09-01" } });
    fireEvent.blur(dueInput);
    await flush();

    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0]!.ins).toEqual([["id", ["t1", "t2"]]]); // ext1 excluded
    expect((taskUpdates[0]!.payload as { due_date: string }).due_date).toBe("2026-09-01");
  });

  test("the due-date input commits ONCE on blur, not on every intermediate onChange", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1")]);
    usePmStore.setState({ selectedTaskIds: new Set(["t1"]) });

    render(<BulkActionBar selectableIds={new Set(["t1"])} />);
    const dueInput = screen.getByLabelText("Set due date for selected tasks");

    // Simulate scrubbed/intermediate values — none should trigger a write.
    fireEvent.change(dueInput, { target: { value: "2026-01-01" } });
    fireEvent.change(dueInput, { target: { value: "2026-09-01" } });
    await flush();
    expect(writes.filter((w) => w.table === "tasks" && w.op === "update")).toHaveLength(0);

    // Only the blur commits.
    fireEvent.blur(dueInput);
    await flush();
    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates).toHaveLength(1);
    expect((taskUpdates[0]!.payload as { due_date: string }).due_date).toBe("2026-09-01");
  });
});

// ---------------------------------------------------------------------------
// L3 — selection model
// ---------------------------------------------------------------------------
describe("selection model", () => {
  test("setSelection / toggle / clear / selectAllFiltered manage a session set", () => {
    seed(recorderClient().client, [makeTask("t1"), makeTask("t2")]);

    usePmStore.getState().setSelection(["t1", "t2"]);
    expect([...usePmStore.getState().selectedTaskIds].sort()).toEqual(["t1", "t2"]);

    usePmStore.getState().toggleSelected("t1");
    expect([...usePmStore.getState().selectedTaskIds]).toEqual(["t2"]);

    usePmStore.getState().toggleSelected("t9");
    expect([...usePmStore.getState().selectedTaskIds].sort()).toEqual(["t2", "t9"]);

    usePmStore.getState().selectAllFiltered(["a", "b", "c"]);
    expect([...usePmStore.getState().selectedTaskIds].sort()).toEqual(["a", "b", "c"]);

    usePmStore.getState().clearSelection();
    expect(usePmStore.getState().selectedTaskIds.size).toBe(0);
  });

  test("setActiveProject clears the selection", () => {
    seed(recorderClient().client, [makeTask("t1")]);
    usePmStore.getState().setSelection(["t1"]);
    // Register a second project so setActiveProject has a target to switch to.
    usePmStore.setState((s) => ({
      projectData: {
        ...s.projectData,
        p2: {
          tasks: [],
          subteams: [],
          subsystems: [],
          users: [],
          dependencies: [],
          milestones: [],
          pages: [],
          blocks: [],
          activity: [],
          vendors: [],
          comments: [],
          buildRecords: [],
          events: [],
        },
      },
      activeProjectId: "p1",
    }));
    usePmStore.getState().setActiveProject("p2");
    expect(usePmStore.getState().selectedTaskIds.size).toBe(0);
  });

  test("setActiveProject clears the undo/redo stacks", async () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1", { priority: "low" })]);
    // Build some undo + redo history in p1.
    usePmStore.getState().updateTask("t1", { priority: "high" });
    await flush();
    usePmStore.getState().undo();
    await flush();
    expect(usePmStore.getState().undoStack.length).toBe(0);
    expect(usePmStore.getState().redoStack.length).toBe(1);

    // Register a second project to switch to.
    usePmStore.setState((s) => ({
      projectData: {
        ...s.projectData,
        p2: {
          tasks: [],
          subteams: [],
          subsystems: [],
          users: [],
          dependencies: [],
          milestones: [],
          pages: [],
          blocks: [],
          activity: [],
          vendors: [],
          comments: [],
          buildRecords: [],
          events: [],
        },
      },
      activeProjectId: "p1",
    }));

    usePmStore.getState().setActiveProject("p2");
    // History from p1 must not survive the switch — replaying it would fire DB
    // writes against rows that belong to the previous project.
    expect(usePmStore.getState().undoStack.length).toBe(0);
    expect(usePmStore.getState().redoStack.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L5 — undo / redo
// ---------------------------------------------------------------------------
describe("undo / redo command model", () => {
  test("a single updateTask is undoable and issues a reversing write", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { priority: "low" })]);

    usePmStore.getState().updateTask("t1", { priority: "high" });
    await flush();
    expect(usePmStore.getState().tasks[0]!.priority).toBe("high");
    expect(usePmStore.getState().undoStack.length).toBe(1);

    usePmStore.getState().undo();
    await flush();
    expect(usePmStore.getState().tasks[0]!.priority).toBe("low"); // reverted
    expect(usePmStore.getState().undoStack.length).toBe(0);
    expect(usePmStore.getState().redoStack.length).toBe(1);
    // A reversing tasks update actually hit the DB.
    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates.length).toBeGreaterThanOrEqual(2); // forward + reverse
  });

  test("undo of a bulk priority change restores each prior value", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [
      makeTask("t1", { priority: "low" }),
      makeTask("t2", { priority: "critical" }),
    ]);

    usePmStore.getState().bulkUpdateTasks(["t1", "t2"], { priority: "high" });
    await flush();
    expect(usePmStore.getState().tasks.map((t) => t.priority)).toEqual(["high", "high"]);

    usePmStore.getState().undo();
    await flush();
    const byId = (id: string) => usePmStore.getState().tasks.find((t) => t.id === id)!;
    expect(byId("t1").priority).toBe("low");
    expect(byId("t2").priority).toBe("critical");
    // The reverse path issued writes for the heterogeneous prior values.
    const reverse = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(reverse.length).toBeGreaterThanOrEqual(2);
  });

  test("redo re-applies the after-image", async () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1", { status: "not_started" })]);

    usePmStore.getState().updateTask("t1", { status: "done" });
    await flush();
    usePmStore.getState().undo();
    await flush();
    expect(usePmStore.getState().tasks[0]!.status).toBe("not_started");

    usePmStore.getState().redo();
    await flush();
    expect(usePmStore.getState().tasks[0]!.status).toBe("done");
    expect(usePmStore.getState().undoStack.length).toBe(1);
    expect(usePmStore.getState().redoStack.length).toBe(0);
  });

  test("undo whose reversing write fails surfaces lastWriteError without corrupting state", async () => {
    // Success client for the forward edit; swap to a failing client for undo.
    const ok = recorderClient(null);
    seed(ok.client, [makeTask("t1", { priority: "low" })]);
    usePmStore.getState().updateTask("t1", { priority: "high" });
    await flush();

    const fail = recorderClient({ message: "denied" });
    usePmStore.setState({ client: fail.client });

    usePmStore.getState().undo();
    // optimistic revert applied
    expect(usePmStore.getState().tasks[0]!.priority).toBe("low");
    await flush();
    // reversing write failed → rolled back to the post-edit value, error surfaced
    expect(usePmStore.getState().tasks[0]!.priority).toBe("high");
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("undo whose reversing write FAILS leaves the undo/redo stacks unchanged (still undoable)", async () => {
    const ok = recorderClient(null);
    seed(ok.client, [makeTask("t1", { priority: "low" })]);
    usePmStore.getState().updateTask("t1", { priority: "high" });
    await flush();
    expect(usePmStore.getState().undoStack.length).toBe(1);
    expect(usePmStore.getState().redoStack.length).toBe(0);

    const fail = recorderClient({ message: "denied" });
    usePmStore.setState({ client: fail.client });

    usePmStore.getState().undo();
    await flush();

    // The reversing write failed, so BOTH the data AND the stacks must roll back
    // together — the command stays on the undo stack and never leaks onto redo.
    expect(usePmStore.getState().tasks[0]!.priority).toBe("high"); // data rolled back
    expect(usePmStore.getState().undoStack.length).toBe(1); // still undoable
    expect(usePmStore.getState().redoStack.length).toBe(0); // never moved to redo
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);

    // Stacks are consistent: a fresh undo (now against a working client) succeeds.
    usePmStore.setState({ client: ok.client, lastWriteError: null });
    usePmStore.getState().undo();
    await flush();
    expect(usePmStore.getState().tasks[0]!.priority).toBe("low");
    expect(usePmStore.getState().undoStack.length).toBe(0);
    expect(usePmStore.getState().redoStack.length).toBe(1);
  });

  test("redo whose reversing write FAILS leaves the undo/redo stacks unchanged", async () => {
    const ok = recorderClient(null);
    seed(ok.client, [makeTask("t1", { status: "not_started" })]);
    usePmStore.getState().updateTask("t1", { status: "done" });
    await flush();
    usePmStore.getState().undo();
    await flush();
    // Now one command sits on the redo stack.
    expect(usePmStore.getState().redoStack.length).toBe(1);
    expect(usePmStore.getState().undoStack.length).toBe(0);

    const fail = recorderClient({ message: "denied" });
    usePmStore.setState({ client: fail.client, lastWriteError: null });

    usePmStore.getState().redo();
    await flush();

    expect(usePmStore.getState().tasks[0]!.status).toBe("not_started"); // data rolled back
    expect(usePmStore.getState().redoStack.length).toBe(1); // still redoable
    expect(usePmStore.getState().undoStack.length).toBe(0); // never moved to undo
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("undo does not push a new undo entry (withHistory:false)", async () => {
    const { client } = recorderClient(null);
    seed(client, [makeTask("t1", { priority: "low" })]);
    usePmStore.getState().updateTask("t1", { priority: "high" });
    await flush();
    usePmStore.getState().undo();
    await flush();
    // The undo's own reversing edit must NOT have created a fresh undo command.
    expect(usePmStore.getState().undoStack.length).toBe(0);
  });
});
