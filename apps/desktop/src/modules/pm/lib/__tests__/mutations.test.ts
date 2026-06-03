import { describe, expect, test } from "vitest";
import type {
  CalendarEvent,
  Milestone,
  Subteam,
  TaskComment,
  TaskDependency,
  TaskRow,
  Vendor,
} from "@helios/pm-ui";
import type { SupabaseClient } from "@helios/auth";
import {
  batchPatchTasks,
  insertComment,
  insertDependency,
  insertEvent,
  insertMilestone,
  insertSubteam,
  insertTask,
  insertVendor,
  patchEvent,
  patchMilestone,
  patchProject,
  patchSubteam,
  patchTask,
  patchVendor,
  removeComment,
  removeDependency,
  removeEvent,
  removeMilestone,
  removeSubteam,
  removeTask,
  removeVendor,
  upsertBuildRecord,
} from "../mutations";

interface Recorded {
  schema: string;
  table: string;
  op: "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  opts?: unknown;
  eqs: Array<[string, unknown]>;
  // `.in(col, values)` calls — used by the batch (bulk) write path.
  ins: Array<[string, unknown]>;
}

// A chainable recorder that mimics the slice of supabase-js the write layer
// uses: client.schema(s).from(t).insert/update/upsert/delete(...).eq(...).
function makeClient(error: { message: string } | null = null) {
  const calls: Recorded[] = [];
  function table(schema: string, table: string) {
    function start(op: Recorded["op"], payload?: unknown, opts?: unknown) {
      const rec: Recorded = { schema, table, op, payload, opts, eqs: [], ins: [] };
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
          calls.push(rec);
          return Promise.resolve({ data: null, error }).then(onF);
        },
      };
      return chain;
    }
    return {
      insert: (p: unknown) => start("insert", p),
      update: (p: unknown) => start("update", p),
      upsert: (p: unknown, o?: unknown) => start("upsert", p, o),
      delete: () => start("delete"),
    };
  }
  const client = {
    schema: (s: string) => ({ from: (t: string) => table(s, t) }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const SUBTEAM: Subteam = {
  id: "st1",
  name: "Aero",
  code: "AE",
  slug: "aero",
  color: "#f00",
};

function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    project_id: "p1",
    subteam_id: "st1",
    subsystem_id: null,
    parent_task_id: null,
    title: "Design wing",
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

describe("task mutations", () => {
  test("insertTask writes only pm.tasks columns and strips the embedded objects", async () => {
    const { client, calls } = makeClient();
    await insertTask(client, makeTask());
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ schema: "pm", table: "tasks", op: "insert" });
    const payload = calls[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ id: "t1", title: "Design wing", subteam_id: "st1" });
    expect(payload).not.toHaveProperty("subteam");
    expect(payload).not.toHaveProperty("subsystem");
    expect(payload).not.toHaveProperty("owner");
  });

  test("patchTask updates only the patched columns, scoped by id", async () => {
    const { client, calls } = makeClient();
    await patchTask(client, "t1", { status: "done", subteam: SUBTEAM });
    expect(calls[0]!).toMatchObject({ schema: "pm", table: "tasks", op: "update" });
    const payload = calls[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ status: "done" });
    expect(calls[0]!.eqs).toEqual([["id", "t1"]]);
  });

  test("removeTask deletes the row scoped by id", async () => {
    const { client, calls } = makeClient();
    await removeTask(client, "t1");
    expect(calls[0]!).toMatchObject({ table: "tasks", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "t1"]]);
  });

  test("batchPatchTasks issues ONE update scoped by an id array with stripped columns", async () => {
    const { client, calls } = makeClient();
    await batchPatchTasks(client, ["t1", "t2", "t3"], {
      priority: "high",
      subteam: SUBTEAM, // embedded object must be stripped
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ schema: "pm", table: "tasks", op: "update" });
    const payload = calls[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ priority: "high" });
    expect(payload).not.toHaveProperty("subteam");
    // Scoped by .in("id", [...]) — NOT a series of .eq calls.
    expect(calls[0]!.ins).toEqual([["id", ["t1", "t2", "t3"]]]);
    expect(calls[0]!.eqs).toEqual([]);
  });

  test("batchPatchTasks surfaces a Postgrest error as a thrown Error", async () => {
    const { client } = makeClient({ message: "permission denied for table tasks" });
    await expect(batchPatchTasks(client, ["t1"], { status: "done" })).rejects.toThrow(
      /update tasks: permission denied/,
    );
  });
});

describe("dependency mutations", () => {
  const dep: TaskDependency = {
    predecessor_id: "a",
    successor_id: "b",
    dep_type: "FS",
    lag_days: 0,
  };

  test("insertDependency inserts into pm.task_dependencies", async () => {
    const { client, calls } = makeClient();
    await insertDependency(client, dep);
    expect(calls[0]!).toMatchObject({ table: "task_dependencies", op: "insert", payload: dep });
  });

  test("removeDependency deletes by both endpoints", async () => {
    const { client, calls } = makeClient();
    await removeDependency(client, "a", "b");
    expect(calls[0]!).toMatchObject({ table: "task_dependencies", op: "delete" });
    expect(calls[0]!.eqs).toEqual([
      ["predecessor_id", "a"],
      ["successor_id", "b"],
    ]);
  });
});

describe("comment mutations", () => {
  const comment: TaskComment = {
    id: "c1",
    task_id: "t1",
    author_id: "u1",
    body: "looks good",
    created_at: "2026-06-02T00:00:00.000Z",
    kind: "general",
  };

  test("insertComment inserts into pm.task_comments", async () => {
    const { client, calls } = makeClient();
    await insertComment(client, comment);
    expect(calls[0]!).toMatchObject({ table: "task_comments", op: "insert", payload: comment });
  });

  test("removeComment deletes by id", async () => {
    const { client, calls } = makeClient();
    await removeComment(client, "c1");
    expect(calls[0]!).toMatchObject({ table: "task_comments", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "c1"]]);
  });
});

describe("milestone mutations", () => {
  const m: Milestone = {
    id: "m1",
    project_id: "p1",
    name: "PDR",
    target_date: "2026-09-01",
    type: "design_review",
    description: null,
  };

  test("insertMilestone inserts into pm.milestones", async () => {
    const { client, calls } = makeClient();
    await insertMilestone(client, m);
    expect(calls[0]!).toMatchObject({ table: "milestones", op: "insert", payload: m });
  });

  test("patchMilestone updates by id", async () => {
    const { client, calls } = makeClient();
    await patchMilestone(client, "m1", { name: "CDR" });
    expect(calls[0]!).toMatchObject({ table: "milestones", op: "update", payload: { name: "CDR" } });
    expect(calls[0]!.eqs).toEqual([["id", "m1"]]);
  });

  test("removeMilestone deletes by id", async () => {
    const { client, calls } = makeClient();
    await removeMilestone(client, "m1");
    expect(calls[0]!).toMatchObject({ table: "milestones", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "m1"]]);
  });
});

describe("vendor mutations", () => {
  const v: Vendor = {
    id: "v1",
    project_id: "p1",
    name: "Acme",
    category: "machining",
    contact_name: null,
    email: null,
    phone: null,
    website: null,
    location: null,
    processes: [],
    machining: null,
    lead_time_days: null,
    status: "active",
    notes: null,
  };

  test("insertVendor inserts into pm.vendors", async () => {
    const { client, calls } = makeClient();
    await insertVendor(client, v);
    expect(calls[0]!).toMatchObject({ table: "vendors", op: "insert", payload: v });
  });

  test("patchVendor updates by id", async () => {
    const { client, calls } = makeClient();
    await patchVendor(client, "v1", { status: "preferred" });
    expect(calls[0]!).toMatchObject({ table: "vendors", op: "update", payload: { status: "preferred" } });
    expect(calls[0]!.eqs).toEqual([["id", "v1"]]);
  });

  test("removeVendor deletes by id", async () => {
    const { client, calls } = makeClient();
    await removeVendor(client, "v1");
    expect(calls[0]!).toMatchObject({ table: "vendors", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "v1"]]);
  });
});

describe("calendar event mutations", () => {
  const e: CalendarEvent = {
    id: "e1",
    project_id: "p1",
    title: "Comp",
    date: "2026-05-01",
    all_subteams: true,
    subteam_ids: [],
    type_tags: [],
    description: null,
  };

  test("insertEvent inserts into pm.calendar_events", async () => {
    const { client, calls } = makeClient();
    await insertEvent(client, e);
    expect(calls[0]!).toMatchObject({ table: "calendar_events", op: "insert", payload: e });
  });

  test("patchEvent updates by id", async () => {
    const { client, calls } = makeClient();
    await patchEvent(client, "e1", { title: "Competition" });
    expect(calls[0]!).toMatchObject({ table: "calendar_events", op: "update" });
    expect(calls[0]!.eqs).toEqual([["id", "e1"]]);
  });

  test("removeEvent deletes by id", async () => {
    const { client, calls } = makeClient();
    await removeEvent(client, "e1");
    expect(calls[0]!).toMatchObject({ table: "calendar_events", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "e1"]]);
  });
});

describe("subteam mutations", () => {
  test("insertSubteam inserts into pm.subteams", async () => {
    const { client, calls } = makeClient();
    await insertSubteam(client, SUBTEAM);
    expect(calls[0]!).toMatchObject({ table: "subteams", op: "insert", payload: SUBTEAM });
  });

  test("patchSubteam updates by id", async () => {
    const { client, calls } = makeClient();
    await patchSubteam(client, "st1", { name: "Aerodynamics" });
    expect(calls[0]!).toMatchObject({ table: "subteams", op: "update" });
    expect(calls[0]!.eqs).toEqual([["id", "st1"]]);
  });

  test("removeSubteam deletes by id", async () => {
    const { client, calls } = makeClient();
    await removeSubteam(client, "st1");
    expect(calls[0]!).toMatchObject({ table: "subteams", op: "delete" });
    expect(calls[0]!.eqs).toEqual([["id", "st1"]]);
  });
});

describe("build record + project mutations", () => {
  test("upsertBuildRecord upserts on task_id", async () => {
    const { client, calls } = makeClient();
    await upsertBuildRecord(client, "t1", {
      task_id: "t1",
      part_file: null,
      drawing_file: null,
      drawing_review: "pending",
    });
    expect(calls[0]!).toMatchObject({ table: "build_records", op: "upsert" });
    expect(calls[0]!.opts).toEqual({ onConflict: "task_id" });
    expect(calls[0]!.payload).toMatchObject({ task_id: "t1", drawing_review: "pending" });
  });

  test("patchProject renames by id", async () => {
    const { client, calls } = makeClient();
    await patchProject(client, "p1", { name: "Renamed" });
    expect(calls[0]!).toMatchObject({ table: "projects", op: "update", payload: { name: "Renamed" } });
    expect(calls[0]!.eqs).toEqual([["id", "p1"]]);
  });
});

describe("error handling", () => {
  test("a write surfaces the Postgrest error as a thrown Error", async () => {
    const { client } = makeClient({ message: "permission denied for table tasks" });
    await expect(insertTask(client, makeTask())).rejects.toThrow(
      /create task: permission denied/,
    );
  });
});
