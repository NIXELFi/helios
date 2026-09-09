import { describe, it, expect } from "vitest";
import type {
  Activity,
  CalendarEvent,
  Milestone,
  Subteam,
  TaskComment,
  TaskLink,
} from "@helios/pm-ui";
import type { RawWorkspace } from "../data";
import { applyPmEvents, pmEventFrom, spliceTaskRows, type PmEvent } from "../pm-apply";

const EMPTY: RawWorkspace = {
  projectsRaw: [],
  subteams: [],
  subsystems: [],
  users: [],
  tasksRaw: [],
  depsRaw: [],
  milestones: [],
  pages: [],
  blocks: [],
  vendors: [],
  comments: [],
  links: [],
  build: [],
  events: [],
  activity: [],
  rolesRaw: [],
  hiddenSubteamsRaw: [],
};

const raw = (over: Partial<RawWorkspace> = {}): RawWorkspace => ({ ...EMPTY, ...over });

const comment = (id: string, body = id): TaskComment => ({
  id,
  task_id: "t-1",
  author_id: null,
  body,
  kind: "general",
  created_at: "2026-01-01T00:00:00Z",
});
const link = (id: string): TaskLink => ({
  id,
  task_id: "t-1",
  url: `https://x/${id}`,
  label: null,
  created_at: "2026-01-01T00:00:00Z",
  created_by: null,
});
const milestone = (id: string, name = id): Milestone => ({
  id,
  project_id: "p-1",
  name,
  target_date: "2026-04-01",
  type: "gate",
  description: null,
});
const event = (id: string): CalendarEvent => ({
  id,
  project_id: "p-1",
  title: id,
  date: "2026-04-01",
  all_subteams: true,
  subteam_ids: [],
  type_tags: [],
  description: null,
  recurrence: "none",
  recurrence_end: null,
});
const subteam = (id: string, name = id): Subteam => ({
  id,
  name,
  code: id.toUpperCase(),
  slug: id,
  color: null,
  icon: null,
});
const activity = (id: string): Activity => ({
  id,
  project_id: "p-1",
  actor_id: null,
  action: "updated",
  target_type: "task",
  target_id: "t-1",
  target_name: null,
  subteam_ids: [],
  payload: null,
  created_at: "2026-01-01T00:00:00Z",
});
const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  project_id: "p-1",
  title: id,
  ...over,
});

const ev = (
  table: string,
  eventType: PmEvent["eventType"],
  row: Record<string, unknown> | null,
  old: Record<string, unknown> | null = null,
): PmEvent => ({ table, eventType, new: row, old });

describe("applyPmEvents — flat tables", () => {
  it("upserts a task_comment by id", () => {
    const before = raw({ comments: [comment("c-1"), comment("c-2")] });
    const r = applyPmEvents(before, [ev("task_comments", "UPDATE", comment("c-1", "edited"))]);
    expect(r.full).toBe(false);
    expect(r.raw.comments.map((c) => c.body)).toEqual(["edited", "c-2"]);
    // untouched lists keep their identity
    expect(r.raw.links).toBe(before.links);
  });

  it("appends an inserted task_comment", () => {
    const r = applyPmEvents(raw({ comments: [comment("c-1")] }), [
      ev("task_comments", "INSERT", comment("c-2")),
    ]);
    expect(r.raw.comments.map((c) => c.id)).toEqual(["c-1", "c-2"]);
  });

  it("removes a deleted task_link by old.id", () => {
    const r = applyPmEvents(raw({ links: [link("l-1"), link("l-2")] }), [
      ev("task_links", "DELETE", null, { id: "l-1" }),
    ]);
    expect(r.raw.links.map((l) => l.id)).toEqual(["l-2"]);
  });

  it("applies milestones, calendar_events and subteams by id", () => {
    const before = raw({
      milestones: [milestone("m-1")],
      events: [event("e-1")],
      subteams: [subteam("st-1")],
    });
    const r = applyPmEvents(before, [
      ev("milestones", "UPDATE", milestone("m-1", "DR2")),
      ev("calendar_events", "INSERT", event("e-2")),
      ev("subteams", "DELETE", null, { id: "st-1" }),
    ]);
    expect(r.raw.milestones[0]!.name).toBe("DR2");
    expect(r.raw.events.map((e) => e.id)).toEqual(["e-1", "e-2"]);
    expect(r.raw.subteams).toEqual([]);
  });

  it("keys task_dependencies on (predecessor_id, successor_id)", () => {
    const before = raw({
      depsRaw: [
        { predecessor_id: "t-1", successor_id: "t-2", dep_type: "FS", lag_days: 0 },
        { predecessor_id: "t-2", successor_id: "t-3", dep_type: "FS", lag_days: 0 },
      ],
    });
    const updated = applyPmEvents(before, [
      ev("task_dependencies", "UPDATE", {
        predecessor_id: "t-1",
        successor_id: "t-2",
        dep_type: "SS",
        lag_days: 4,
      }),
    ]);
    expect(updated.raw.depsRaw).toHaveLength(2);
    expect(updated.raw.depsRaw[0]).toMatchObject({ dep_type: "SS", lag_days: 4 });

    const removed = applyPmEvents(before, [
      ev("task_dependencies", "DELETE", null, { predecessor_id: "t-2", successor_id: "t-3" }),
    ]);
    expect(removed.raw.depsRaw).toHaveLength(1);
    expect(removed.raw.depsRaw[0]).toMatchObject({ predecessor_id: "t-1" });
  });

  it("keys project_hidden_subteams on (project_id, subteam_id)", () => {
    const before = raw({ hiddenSubteamsRaw: [{ project_id: "p-1", subteam_id: "st-2" }] });
    const added = applyPmEvents(before, [
      ev("project_hidden_subteams", "INSERT", { project_id: "p-1", subteam_id: "st-3" }),
    ]);
    expect(added.raw.hiddenSubteamsRaw).toHaveLength(2);
    const gone = applyPmEvents(before, [
      ev("project_hidden_subteams", "DELETE", null, { project_id: "p-1", subteam_id: "st-2" }),
    ]);
    expect(gone.raw.hiddenSubteamsRaw).toEqual([]);
  });
});

describe("applyPmEvents — activity feed", () => {
  it("prepends an inserted activity row", () => {
    const r = applyPmEvents(raw({ activity: [activity("a-1")] }), [
      ev("activity", "INSERT", activity("a-2")),
    ]);
    expect(r.raw.activity.map((a) => a.id)).toEqual(["a-2", "a-1"]);
  });

  it("caps the feed at the fetch limit of 250", () => {
    const before = raw({ activity: Array.from({ length: 250 }, (_, i) => activity(`a-${i}`)) });
    const r = applyPmEvents(before, [ev("activity", "INSERT", activity("new"))]);
    expect(r.raw.activity).toHaveLength(250);
    expect(r.raw.activity[0]!.id).toBe("new");
    expect(r.raw.activity.at(-1)!.id).toBe("a-248");
  });

  it("does not duplicate a re-delivered insert", () => {
    const before = raw({ activity: [activity("a-1")] });
    const r = applyPmEvents(before, [ev("activity", "INSERT", activity("a-1"))]);
    expect(r.raw.activity).toHaveLength(1);
  });

  it("updates and deletes activity by id", () => {
    const before = raw({ activity: [activity("a-1"), activity("a-2")] });
    const upd = applyPmEvents(before, [
      ev("activity", "UPDATE", { ...activity("a-2"), target_name: "renamed" }),
    ]);
    expect(upd.raw.activity[1]!.target_name).toBe("renamed");
    const del = applyPmEvents(before, [ev("activity", "DELETE", null, { id: "a-1" })]);
    expect(del.raw.activity.map((a) => a.id)).toEqual(["a-2"]);
  });
});

describe("applyPmEvents — task tables", () => {
  it("collects the task id for a tasks UPDATE without touching tasksRaw", () => {
    const before = raw({ tasksRaw: [task("t-1"), task("t-2")] });
    const r = applyPmEvents(before, [ev("tasks", "UPDATE", task("t-1", { title: "new" }))]);
    expect(r.refetchTaskIds).toEqual(["t-1"]);
    // the embeds (subteam/owners) only come back from a re-read, so the cached
    // row is left alone until fetchTaskRowsByIds splices the fresh one in
    expect(r.raw).toBe(before);
  });

  it("collects task_id for task_owners and task_subteams, de-duplicated", () => {
    const before = raw({ tasksRaw: [task("t-1")] });
    const r = applyPmEvents(before, [
      ev("task_owners", "INSERT", { task_id: "t-1", owner_id: "u-1", is_primary: true }),
      ev("task_subteams", "DELETE", null, { task_id: "t-1", subteam_id: "st-2" }),
      ev("tasks", "UPDATE", task("t-1")),
    ]);
    expect(r.refetchTaskIds).toEqual(["t-1"]);
    expect(r.full).toBe(false);
  });

  it("removes a deleted task immediately and does not refetch it", () => {
    const before = raw({ tasksRaw: [task("t-1"), task("t-2")] });
    const r = applyPmEvents(before, [ev("tasks", "DELETE", null, { id: "t-1" })]);
    expect(r.raw.tasksRaw.map((t) => t.id)).toEqual(["t-2"]);
    expect(r.refetchTaskIds).toEqual([]);
  });

  it("falls back to a full pull when a DELETE carries no key", () => {
    const before = raw({ comments: [comment("c-1")] });
    expect(applyPmEvents(before, [ev("task_comments", "DELETE", null, null)]).full).toBe(true);
    expect(applyPmEvents(before, [ev("task_owners", "DELETE", null, {})]).full).toBe(true);
    expect(applyPmEvents(before, [ev("tasks", "DELETE", null, {})]).full).toBe(true);
  });

  it("falls back to a full pull for an unknown table", () => {
    const before = raw();
    const r = applyPmEvents(before, [ev("vendors", "INSERT", { id: "v-1" })]);
    expect(r.full).toBe(true);
    expect(r.raw).toBe(before);
  });

  it("falls back to a full pull when an upsert payload has no row", () => {
    expect(applyPmEvents(raw(), [ev("milestones", "INSERT", null)]).full).toBe(true);
  });
});

describe("applyPmEvents — identity", () => {
  it("returns the same raw for no events", () => {
    const before = raw({ comments: [comment("c-1")] });
    const r = applyPmEvents(before, []);
    expect(r.raw).toBe(before);
    expect(r.full).toBe(false);
    expect(r.refetchTaskIds).toEqual([]);
  });

  it("returns the same raw when a delete matches nothing", () => {
    const before = raw({ comments: [comment("c-1")] });
    expect(applyPmEvents(before, [ev("task_comments", "DELETE", null, { id: "nope" })]).raw).toBe(
      before,
    );
  });
});

describe("spliceTaskRows", () => {
  it("replaces refetched rows in place and appends new ones", () => {
    const before = raw({ tasksRaw: [task("t-1"), task("t-2")] });
    const next = spliceTaskRows(before, ["t-1", "t-3"], [task("t-1", { title: "fresh" }), task("t-3")]);
    expect(next.tasksRaw.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    expect(next.tasksRaw[0]!.title).toBe("fresh");
  });

  it("drops requested ids the server did not return (deleted or RLS-hidden)", () => {
    const before = raw({ tasksRaw: [task("t-1"), task("t-2")] });
    const next = spliceTaskRows(before, ["t-1"], []);
    expect(next.tasksRaw.map((t) => t.id)).toEqual(["t-2"]);
  });

  it("leaves rows outside the requested set alone", () => {
    const before = raw({ tasksRaw: [task("t-1"), task("t-2")] });
    const next = spliceTaskRows(before, ["t-2"], [task("t-2", { title: "x" })]);
    expect(next.tasksRaw[0]).toBe(before.tasksRaw[0]);
  });

  it("returns the same raw when nothing was requested", () => {
    const before = raw({ tasksRaw: [task("t-1")] });
    expect(spliceTaskRows(before, [], [])).toBe(before);
  });
});

describe("pmEventFrom", () => {
  it("normalises a supabase postgres_changes payload", () => {
    const e = pmEventFrom("tasks", {
      eventType: "UPDATE",
      schema: "pm",
      table: "tasks",
      new: { id: "t-1" },
      old: { id: "t-1" },
    });
    expect(e).toEqual({ table: "tasks", eventType: "UPDATE", new: { id: "t-1" }, old: { id: "t-1" } });
  });

  it("treats supabase's empty {} old/new as absent", () => {
    const e = pmEventFrom("tasks", { eventType: "DELETE", new: {}, old: {} });
    expect(e.new).toBeNull();
    expect(e.old).toBeNull();
  });

  it("survives a payload with no eventType", () => {
    const e = pmEventFrom("tasks", {});
    expect(e.eventType).toBe("UPDATE");
    expect(e.new).toBeNull();
  });
});
