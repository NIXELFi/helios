import { beforeEach, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import type { CalendarEvent, Subteam, TaskRow } from "@helios/pm-ui";
import { usePmStore } from "../pmStore";

// Chainable recorder mock — same slice of supabase-js the write layer uses.
// `error` controls whether every write resolves ok or fails.
function recorderClient(error: { message: string } | null = null) {
  const writes: Array<{ table: string; op: string }> = [];
  function tbl(table: string) {
    function start(op: string) {
      const chain = {
        eq() {
          return chain;
        },
        then<R>(onF: (v: { data: null; error: typeof error }) => R) {
          writes.push({ table, op });
          return Promise.resolve({ data: null, error }).then(onF);
        },
      };
      return chain;
    }
    return {
      insert: () => start("insert"),
      update: () => start("update"),
      upsert: () => start("upsert"),
      delete: () => start("delete"),
    };
  }
  const client = {
    schema: () => ({ from: (t: string) => tbl(t) }),
  } as unknown as SupabaseClient;
  return { client, writes };
}

const SUBTEAM: Subteam = { id: "st1", name: "Aero", code: "AE", slug: "aero", color: null };

function makeTask(id: string): TaskRow {
  return {
    id,
    project_id: "p1",
    subteam_id: "st1",
    subsystem_id: null,
    parent_task_id: null,
    title: `task ${id}`,
    description: null,
    type: "general",
    status: "backlog",
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
  } as TaskRow;
}

// Set up a minimal signed-in store backed by the given client.
function seed(client: SupabaseClient, tasks: TaskRow[] = []) {
  usePmStore.setState({
    client,
    projectId: "p1",
    currentUserId: "u1",
    tasks,
    subteams: [SUBTEAM],
    subsystems: [],
    users: [],
    dependencies: [],
    activity: [],
    lastWriteError: null,
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
    expect(writes).toContainEqual({ table: "tasks", op: "insert" });
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
