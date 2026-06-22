import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SupabaseClient } from "@helios/auth";
import type { CalendarEvent, Subteam, TaskRow } from "@helios/pm-ui";
import { BulkActionBar } from "@pm/components/BulkActionBar";
import { scopeTasksToSubteam, selectCanEditTask, usePmStore } from "../pmStore";

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
// `.rpc(name, args)` calls recorded separately — the membership-primary flip
// goes through client.schema('pm').rpc('set_task_primary_subteam', …).
interface Rpc {
  name: string;
  args: unknown;
}
// `rows` is what `.select()` resolves to on success. The write layer chains
// `.select()` on every UPDATE/DELETE and treats an empty result as a silent RLS
// denial, so success must return a non-empty set. Pass `[]` to simulate a write
// the DB accepted (no error) but RLS silently dropped (zero rows affected).
function recorderClient(
  error: { message: string } | null = null,
  rows: unknown[] = [{ id: "ok" }],
) {
  const writes: Write[] = [];
  const rpcs: Rpc[] = [];
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
        select(_cols?: string) {
          return chain;
        },
        then<R>(onF: (v: { data: unknown[] | null; error: typeof error }) => R) {
          writes.push(rec);
          return Promise.resolve({ data: error ? null : rows, error }).then(onF);
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
  function rpc(name: string, args: unknown) {
    return {
      then<R>(onF: (v: { data: null; error: typeof error }) => R) {
        rpcs.push({ name, args });
        return Promise.resolve({ data: null, error }).then(onF);
      },
    };
  }
  const client = {
    schema: () => ({
      from: (t: string) => tbl(t),
      rpc: (name: string, args: unknown) => rpc(name, args),
    }),
  } as unknown as SupabaseClient;
  return { client, writes, rpcs };
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
    subteams: [SUBTEAM],
    subsystem: null,
    owner: null,
    owners: [],
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
    baselineOrg: { subteams: [SUBTEAM, SUBTEAM2], subsystems: [SUBSYS1], users: [USER1] },
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

  test("inFlightWrites tracks a pending write (so a background refresh can skip it)", async () => {
    const { client } = recorderClient(null);
    seed(client);
    usePmStore.setState({ inFlightWrites: 0 });

    usePmStore.getState().addTask(makeTask("t1"));
    expect(usePmStore.getState().inFlightWrites).toBe(1); // persisting

    await flush();
    expect(usePmStore.getState().inFlightWrites).toBe(0); // settled
  });

  test("addTask rolls the new task back and records an error when the write fails", async () => {
    const { client } = recorderClient({ message: "permission denied for table tasks" });
    seed(client);
    const task = makeTask("t1");

    usePmStore.getState().addTask(task);
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeTruthy(); // optimistic

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")).toBeFalsy(); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/don't have permission/i);
  });

  test("updateTask rolls back + surfaces an error when RLS silently denies (zero rows, no error)", async () => {
    // The Nora bug: PostgREST returns 200 + no error but updates zero rows
    // because RLS hid the task from the UPDATE. The edit must NOT stick — it has
    // to roll back and tell the user why, not look saved and revert on reload.
    const { client } = recorderClient(null, []);
    const task = makeTask("t1", { priority: "low" });
    seed(client, [task]);

    usePmStore.getState().updateTask("t1", { priority: "high" });
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")?.priority).toBe("high"); // optimistic

    await flush();
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")?.priority).toBe("low"); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/don't have permission to edit this task/i);
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
      recurrence: "none",
      recurrence_end: null,
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

  test("blurring the EMPTY due input does NOT wipe the selected tasks' due dates (H-3)", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { due_date: "2026-05-01" })]);
    usePmStore.setState({ selectedTaskIds: new Set(["t1"]) });

    render(<BulkActionBar selectableIds={new Set(["t1"])} />);
    const dueInput = screen.getByLabelText("Set due date for selected tasks");

    // Merely focusing and tabbing away (blur with an empty value) must not write.
    fireEvent.focus(dueInput);
    fireEvent.blur(dueInput);
    await flush();
    expect(writes.filter((w) => w.table === "tasks" && w.op === "update")).toHaveLength(0);
    expect(usePmStore.getState().tasks.find((t) => t.id === "t1")!.due_date).toBe("2026-05-01");
  });

  test("the explicit Clear-due action DOES null the due date", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { due_date: "2026-05-01" })]);
    usePmStore.setState({ selectedTaskIds: new Set(["t1"]) });

    render(<BulkActionBar selectableIds={new Set(["t1"])} />);
    fireEvent.click(screen.getByLabelText("Clear due date for selected tasks"));
    await flush();
    const taskUpdates = writes.filter((w) => w.table === "tasks" && w.op === "update");
    expect(taskUpdates).toHaveLength(1);
    expect((taskUpdates[0]!.payload as { due_date: string | null }).due_date).toBeNull();
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
          links: [],
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
          links: [],
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

// ---------------------------------------------------------------------------
// L6 — multi-subteam memberships (add / remove-with-primary-guard / setPrimary)
// ---------------------------------------------------------------------------
describe("multi-subteam memberships", () => {
  test("addTaskSubteam appends the membership and inserts a non-primary row", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1")]); // primary st1
    usePmStore.getState().addTaskSubteam("t1", "st2");

    const t = usePmStore.getState().tasks[0]!;
    expect(t.subteams.map((s) => s.id)).toEqual(["st1", "st2"]); // appended
    expect(t.subteam_id).toBe("st1"); // primary unchanged

    await flush();
    expect(usePmStore.getState().lastWriteError).toBeNull();
    const ins = writes.filter((w) => w.table === "task_subteams" && w.op === "insert");
    expect(ins).toHaveLength(1);
    expect(ins[0]!.payload).toEqual({ task_id: "t1", subteam_id: "st2", is_primary: false });
  });

  test("addTaskSubteam rolls back the membership on a failed write", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1")]);
    usePmStore.getState().addTaskSubteam("t1", "st2");
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);

    await flush();
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1"]); // rolled back
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("addTaskSubteam is a no-op when the subteam is already a member", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]);
    usePmStore.getState().addTaskSubteam("t1", "st2");
    await flush();
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);
    expect(writes.filter((w) => w.table === "task_subteams")).toHaveLength(0);
  });

  test("removeTaskSubteam removes a non-primary membership and deletes its row", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]);
    usePmStore.getState().removeTaskSubteam("t1", "st2");

    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1"]);
    await flush();
    const del = writes.filter((w) => w.table === "task_subteams" && w.op === "delete");
    expect(del).toHaveLength(1);
    expect(del[0]!.eqs).toEqual([
      ["task_id", "t1"],
      ["subteam_id", "st2"],
    ]);
  });

  test("removeTaskSubteam GUARDS the primary — removing it is a no-op (no write)", async () => {
    const { client, writes } = recorderClient(null);
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]); // primary st1
    usePmStore.getState().removeTaskSubteam("t1", "st1"); // attempt to drop primary
    await flush();
    // Membership list untouched and NO delete issued.
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);
    expect(writes.filter((w) => w.table === "task_subteams")).toHaveLength(0);
  });

  test("removeTaskSubteam rolls back on a failed write", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]);
    usePmStore.getState().removeTaskSubteam("t1", "st2");
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1"]); // optimistic
    await flush();
    expect(usePmStore.getState().tasks[0]!.subteams.map((s) => s.id)).toEqual(["st1", "st2"]); // restored
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("setPrimarySubteam promotes an existing membership and calls the RPC", async () => {
    const { client, rpcs } = recorderClient(null);
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]); // primary st1
    const before = usePmStore.getState().activity.length;

    usePmStore.getState().setPrimarySubteam("t1", "st2");

    const t = usePmStore.getState().tasks[0]!;
    expect(t.subteam_id).toBe("st2");
    expect(t.subteam.id).toBe("st2");
    expect(t.subteams.map((s) => s.id)).toEqual(["st2", "st1"]); // reordered primary-first
    // Logs an 'updated' activity.
    expect(usePmStore.getState().activity.length).toBe(before + 1);
    expect(usePmStore.getState().activity[0]!.action).toBe("updated");

    await flush();
    expect(usePmStore.getState().lastWriteError).toBeNull();
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]!).toEqual({
      name: "set_task_primary_subteam",
      args: { p_task_id: "t1", p_subteam_id: "st2" },
    });
  });

  test("setPrimarySubteam rolls back primary/order on a failed RPC", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [makeTask("t1", { subteams: [SUBTEAM, SUBTEAM2] })]);
    usePmStore.getState().setPrimarySubteam("t1", "st2");
    expect(usePmStore.getState().tasks[0]!.subteam_id).toBe("st2"); // optimistic

    await flush();
    const t = usePmStore.getState().tasks[0]!;
    expect(t.subteam_id).toBe("st1"); // rolled back
    expect(t.subteam.id).toBe("st1");
    expect(t.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });

  test("setPrimarySubteam is a no-op for a non-member subteam (no RPC)", async () => {
    const { client, rpcs } = recorderClient(null);
    seed(client, [makeTask("t1")]); // only st1
    usePmStore.getState().setPrimarySubteam("t1", "st2"); // st2 not a member
    await flush();
    expect(usePmStore.getState().tasks[0]!.subteam_id).toBe("st1");
    expect(rpcs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// L7 — scopeTasksToSubteam treats EVERY membership as "owned"
// ---------------------------------------------------------------------------
describe("scopeTasksToSubteam with multi-subteam tasks", () => {
  test("a 2-subteam task is owned in BOTH member teams' scoped views", () => {
    const multi = makeTask("tm", { subteam_id: "st1", subteams: [SUBTEAM, SUBTEAM2] });
    const tasks = [multi];

    const inSt1 = scopeTasksToSubteam(tasks, [], "st1");
    const inSt2 = scopeTasksToSubteam(tasks, [], "st2");

    const owned = (scoped: ReturnType<typeof scopeTasksToSubteam>) =>
      scoped.find((s) => s.task.id === "tm" && s.relation === "owned");
    expect(owned(inSt1)).toBeTruthy(); // owned via primary membership
    expect(owned(inSt2)).toBeTruthy(); // owned via secondary membership
  });

  test("a single-subteam task is owned only in its one team", () => {
    const solo = makeTask("ts", { subteam_id: "st1", subteams: [SUBTEAM] });
    expect(scopeTasksToSubteam([solo], [], "st1").some((s) => s.relation === "owned")).toBe(true);
    expect(scopeTasksToSubteam([solo], [], "st2").some((s) => s.relation === "owned")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L8 — deleteSubteam with co-owned tasks (reassign primary, keep co-owned tasks)
// ---------------------------------------------------------------------------
describe("deleteSubteam with multi-subteam tasks", () => {
  test("reassigns a sole-membership task to the fallback (non-destructive) and re-homes co-owned tasks", async () => {
    const { client, writes, rpcs } = recorderClient(null);
    // sole: only belongs to st1 (doomed) → deleted.
    // coPrimary: st1 is primary but co-owned with st2 → primary reassigned to st2, kept.
    // coSecondary: st2 primary, st1 secondary → loses st1 membership, kept.
    seed(client, [
      makeTask("sole", { subteam_id: "st1", subteams: [SUBTEAM] }),
      makeTask("coPrimary", { subteam_id: "st1", subteams: [SUBTEAM, SUBTEAM2] }),
      makeTask("coSecondary", { subteam_id: "st2", subteam: SUBTEAM2, subteams: [SUBTEAM2, SUBTEAM] }),
    ]);

    usePmStore.getState().deleteSubteam("st1", "st2");

    const byId = (id: string) => usePmStore.getState().tasks.find((t) => t.id === id);
    // Sole-membership task is REASSIGNED to the fallback, not deleted.
    expect(byId("sole")).toBeTruthy();
    expect(byId("sole")!.subteam_id).toBe("st2");
    expect(byId("sole")!.subteams.map((s) => s.id)).toEqual(["st2"]);
    // Co-owned task with st1 primary → promoted to st2, kept.
    expect(byId("coPrimary")!.subteam_id).toBe("st2");
    expect(byId("coPrimary")!.subteam.id).toBe("st2");
    expect(byId("coPrimary")!.subteams.map((s) => s.id)).toEqual(["st2"]);
    // Co-owned task with st1 secondary → keeps st2 primary, drops st1.
    expect(byId("coSecondary")!.subteam_id).toBe("st2");
    expect(byId("coSecondary")!.subteams.map((s) => s.id)).toEqual(["st2"]);
    // The subteam itself is removed from the org list.
    expect(usePmStore.getState().subteams.some((s) => s.id === "st1")).toBe(false);

    await flush();
    expect(usePmStore.getState().lastWriteError).toBeNull();

    // Non-destructive: NO task was hard-deleted.
    expect(writes.some((w) => w.table === "tasks" && w.op === "delete")).toBe(false);
    // The reassignment RPC fired and the subteam delete ran.
    expect(rpcs.some((r) => r.name === "set_task_primary_subteam")).toBe(true);
    expect(writes.some((w) => w.table === "subteams" && w.op === "delete")).toBe(true);
  });

  test("rolls everything back if the subteam delete fails", async () => {
    const { client } = recorderClient({ message: "denied" });
    seed(client, [
      makeTask("sole", { subteam_id: "st1", subteams: [SUBTEAM] }),
      makeTask("coPrimary", { subteam_id: "st1", subteams: [SUBTEAM, SUBTEAM2] }),
    ]);

    usePmStore.getState().deleteSubteam("st1", "st2");
    expect(usePmStore.getState().tasks.find((t) => t.id === "sole")!.subteam_id).toBe("st2"); // optimistic reassign

    await flush();
    // Full rollback: both tasks restored to their original membership shape.
    const byId = (id: string) => usePmStore.getState().tasks.find((t) => t.id === id);
    expect(byId("sole")!.subteam_id).toBe("st1");
    expect(byId("sole")!.subteams.map((s) => s.id)).toEqual(["st1"]);
    expect(byId("coPrimary")!.subteam_id).toBe("st1");
    expect(byId("coPrimary")!.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);
    expect(usePmStore.getState().subteams.some((s) => s.id === "st1")).toBe(true);
    expect(usePmStore.getState().lastWriteError?.message).toMatch(/denied/i);
  });
});

describe("selectCanEditTask (mirrors pm.can_edit_task RLS)", () => {
  const base = { project_id: "p1", owner_id: null, created_by: null, owners: [] };
  const state = (role: string | null, currentUserId = "me") =>
    ({ projectRoles: role ? { p1: role } : {}, currentUserId }) as never;

  test("admins and leads can edit any task", () => {
    expect(selectCanEditTask(state("admin"), base).allowed).toBe(true);
    expect(selectCanEditTask(state("lead"), base).allowed).toBe(true);
  });

  test("an engineer can edit a task they OWN", () => {
    const r = selectCanEditTask(state("engineer"), { ...base, owner_id: "me" });
    expect(r.allowed).toBe(true);
  });

  test("an engineer can edit a task they CREATED (the created_by fix)", () => {
    const r = selectCanEditTask(state("engineer"), { ...base, created_by: "me" });
    expect(r.allowed).toBe(true);
  });

  test("an engineer can edit a task they CO-OWN (multi-owner)", () => {
    const r = selectCanEditTask(state("engineer"), {
      ...base,
      owner_id: "someone",
      owners: [{ id: "someone", name: "Someone", email: null }, { id: "me", name: "Me", email: null }],
    });
    expect(r.allowed).toBe(true);
  });

  test("an engineer CANNOT edit someone else's task, and is told why", () => {
    const r = selectCanEditTask(state("engineer"), { ...base, owner_id: "someone", created_by: "someone" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/only edit tasks they own or created/i);
  });

  test("viewers and non-members are blocked with a reason", () => {
    expect(selectCanEditTask(state("viewer"), base).reason).toMatch(/view-only/i);
    expect(selectCanEditTask(state(null), base).reason).toMatch(/don't have access/i);
  });
});

describe("hydrate tolerates a stale snapshot missing newer fields (PM-dead regression)", () => {
  // A localStorage snapshot written before 4.4.3 has no `links` field. Before the
  // fix, loadFlat did `[...d.links]` -> "Spread syntax requires ...iterable" and
  // the whole PM module crashed on load. Hydration must now be crash-proof.
  test("a ProjectData without `links` hydrates without throwing", () => {
    const staleProject = {
      tasks: [], subteams: [], subsystems: [], users: [], dependencies: [],
      milestones: [], pages: [], blocks: [], activity: [], vendors: [],
      comments: [], buildRecords: [], events: [],
      // NOTE: no `links` — exactly the shape of a pre-4.4.3 cached snapshot.
    };
    expect(() =>
      usePmStore.getState().hydrate({
        projects: [{ id: "p1", name: "P", description: null }],
        projectData: { p1: staleProject },
        activeProjectId: "p1",
        currentUserId: "u1",
        baselineOrg: { subteams: [], subsystems: [], users: [] },
        client: null,
        roles: { p1: "admin" },
      } as never),
    ).not.toThrow();
    expect(usePmStore.getState().links).toEqual([]);
  });
});

describe("addTask serializes dependent inserts after the task INSERT (H-10)", () => {
  test("extra subteams + dependencies persist AFTER insertTask, in one persist", async () => {
    const { client, writes } = recorderClient(null);
    // A prerequisite task already exists so the dependency targets a real row.
    seed(client, [makeTask("pre", { subteam_id: "st1", subteams: [SUBTEAM] })]);
    const task = makeTask("t-new", { subteam_id: "st1", subteams: [SUBTEAM] });

    usePmStore.getState().addTask(task, {
      extraSubteamIds: ["st2"],
      prerequisiteIds: ["pre"],
    });

    // Optimistic: the membership + dependency show immediately.
    const created = usePmStore.getState().tasks.find((t) => t.id === "t-new")!;
    expect(created.subteams.map((s) => s.id)).toEqual(["st1", "st2"]);
    expect(
      usePmStore.getState().dependencies.some(
        (d) => d.predecessor_id === "pre" && d.successor_id === "t-new",
      ),
    ).toBe(true);

    await flush();
    expect(usePmStore.getState().lastWriteError).toBeNull();

    // Ordering: the task INSERT must come before the membership + dependency
    // inserts (an FK on the dependent rows references the task row).
    const idxTask = writes.findIndex((w) => w.table === "tasks" && w.op === "insert");
    const idxSubteam = writes.findIndex(
      (w) => w.table === "task_subteams" && w.op === "insert",
    );
    const idxDep = writes.findIndex(
      (w) => w.table === "task_dependencies" && w.op === "insert",
    );
    expect(idxTask).toBeGreaterThanOrEqual(0);
    expect(idxSubteam).toBeGreaterThan(idxTask);
    expect(idxDep).toBeGreaterThan(idxTask);
  });

  test("a primary already in extraSubteamIds is not double-inserted", async () => {
    const { client, writes } = recorderClient(null);
    seed(client);
    const task = makeTask("t-dup", { subteam_id: "st1", subteams: [SUBTEAM] });

    // st1 is the primary — passing it as an extra must be ignored (no stray).
    usePmStore.getState().addTask(task, { extraSubteamIds: ["st1"] });

    const created = usePmStore.getState().tasks.find((t) => t.id === "t-dup")!;
    expect(created.subteams.map((s) => s.id)).toEqual(["st1"]);

    await flush();
    expect(writes.some((w) => w.table === "task_subteams" && w.op === "insert")).toBe(false);
  });
});

describe("background re-hydrate preserves a pending write error (toast not suppressed)", () => {
  test("preserveWriteError keeps lastWriteError set", () => {
    usePmStore.setState({ lastWriteError: { message: "denied", at: Date.now() } });
    usePmStore.getState().hydrate({
      projects: [{ id: "p1", name: "P", description: null }],
      projectData: {},
      activeProjectId: "p1",
      currentUserId: "u1",
      baselineOrg: { subteams: [], subsystems: [], users: [] },
      client: null,
      roles: { p1: "admin" },
      preserveWriteError: true,
    } as never);
    expect(usePmStore.getState().lastWriteError?.message).toBe("denied");
  });

  test("a cold load (no flag) still clears the error", () => {
    usePmStore.setState({ lastWriteError: { message: "denied", at: Date.now() } });
    usePmStore.getState().hydrate({
      projects: [{ id: "p1", name: "P", description: null }],
      projectData: {},
      activeProjectId: "p1",
      currentUserId: "u1",
      baselineOrg: { subteams: [], subsystems: [], users: [] },
      client: null,
      roles: { p1: "admin" },
    } as never);
    expect(usePmStore.getState().lastWriteError).toBeNull();
  });
});
