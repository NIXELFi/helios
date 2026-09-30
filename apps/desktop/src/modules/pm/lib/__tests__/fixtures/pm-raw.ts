import type { SupabaseClient } from "@helios/auth";

/**
 * A small but structurally complete set of RAW `pm` rows — exactly the shapes
 * PostgREST hands back — plus a stub client that serves them.
 *
 * It exists so `buildWorkspace` (the pure transform split out of
 * `loadWorkspace` in Task 6) can be proved behaviour-preserving: the golden
 * output in `data-build.test.ts` was captured from `loadWorkspace(stubClient)`
 * BEFORE the split, so the assertion compares the new pure function against the
 * old whole-function behaviour rather than against itself.
 *
 * Covers the transform's branches: numeric-as-string coercion, membership
 * ordering (primary first), the no-membership fallback to the embedded primary
 * subteam, owner resolution through the directory, an unknown owner id, and
 * per-project bucketing of every child list (including a dependency whose
 * predecessor lives in the other project).
 */

export interface RawFixture {
  projects: Array<Record<string, unknown>>;
  subteams: Array<Record<string, unknown>>;
  subsystems: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  task_dependencies: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
  vendors: Array<Record<string, unknown>>;
  task_comments: Array<Record<string, unknown>>;
  task_links: Array<Record<string, unknown>>;
  build_records: Array<Record<string, unknown>>;
  calendar_events: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  project_hidden_subteams: Array<Record<string, unknown>>;
  list_directory: Array<Record<string, unknown>>;
  my_team_roles: Array<Record<string, unknown>>;
}

const ST1 = { id: "st-1", name: "Chassis", code: "CH", slug: "chassis", color: "#8c1d40", icon: null };
const ST2 = { id: "st-2", name: "Aero", code: "AE", slug: "aero", color: "#ffc627", icon: "wing" };
const SS1 = {
  id: "ss-1",
  subteam_id: "st-1",
  parent_subsystem_id: null,
  name: "Main hoop",
  code: "MH",
  color: null,
};

export const RAW_FIXTURE: RawFixture = {
  projects: [
    { id: "p-1", name: "SDM26", description: "Season 26", car_code: "SDM26" },
    { id: "p-2", name: "SDM27", description: null, car_code: "SDM27" },
  ],
  subteams: [ST1, ST2],
  subsystems: [SS1],
  list_directory: [
    { id: "u-1", name: "Ada", email: "ada@asu.edu", subteam_ids: ["st-1"] },
    { id: "u-2", name: "Bo", email: null },
  ],
  tasks: [
    {
      id: "t-1",
      project_id: "p-1",
      subteam_id: "st-1",
      subsystem_id: "ss-1",
      parent_task_id: null,
      title: "Weld main hoop",
      description: "with the good jig",
      type: "part",
      status: "in_progress",
      priority: "high",
      owner_id: "u-1",
      start_date: "2026-03-01",
      due_date: "2026-03-10",
      // numeric columns can arrive as strings from PostgREST
      estimate_days: "2.5",
      mrl: "4",
      on_critical_path: true,
      created_by: "u-2",
      subteam: ST1,
      subsystem: SS1,
      // deliberately NOT primary-first, to pin the sort
      task_subteams: [
        { subteam_id: "st-2", is_primary: false, subteam: ST2 },
        { subteam_id: "st-1", is_primary: true, subteam: ST1 },
      ],
      task_owners: [
        { owner_id: "u-2", is_primary: false },
        { owner_id: "u-1", is_primary: true },
        // an owner the directory doesn't know → dropped
        { owner_id: "u-ghost", is_primary: false },
      ],
    },
    {
      id: "t-2",
      project_id: "p-1",
      subteam_id: "st-2",
      subsystem_id: null,
      parent_task_id: "t-1",
      title: "Undertray layup",
      description: null,
      type: "analysis",
      status: "not_started",
      priority: "low",
      owner_id: null,
      start_date: null,
      due_date: null,
      estimate_days: null,
      mrl: null,
      on_critical_path: false,
      created_by: null,
      subteam: ST2,
      subsystem: null,
      // no membership rows → falls back to the embedded primary subteam
      task_subteams: [],
      task_owners: null,
    },
    {
      id: "t-3",
      project_id: "p-2",
      subteam_id: "st-1",
      subsystem_id: null,
      parent_task_id: null,
      title: "Rules review",
      description: null,
      type: "general",
      status: "done",
      priority: "medium",
      owner_id: "u-2",
      start_date: null,
      due_date: "2026-09-01",
      estimate_days: 1,
      mrl: null,
      on_critical_path: false,
      created_by: "u-1",
      subteam: ST1,
      subsystem: null,
      task_subteams: [{ subteam_id: "st-1", is_primary: true, subteam: ST1 }],
      task_owners: [{ owner_id: "u-2", is_primary: true }],
    },
  ],
  task_dependencies: [
    { predecessor_id: "t-1", successor_id: "t-2", dep_type: "FS", lag_days: "3" },
    // predecessor lives in p-2 → this dependency buckets into p-2
    { predecessor_id: "t-3", successor_id: "t-1", dep_type: "SS", lag_days: null },
  ],
  milestones: [
    { id: "m-1", project_id: "p-1", name: "DR1", target_date: "2026-04-01", type: "design_review", description: null },
    { id: "m-2", project_id: "p-2", name: "Comp", target_date: "2026-06-01", type: "comp_event", description: "Michigan" },
  ],
  pages: [
    { id: "pg-1", project_id: "p-1", subteam_id: "st-1", title: "Notes", icon: null, type: "doc", parent_page_id: null, order_key: "a0" },
  ],
  blocks: [{ id: "b-1", page_id: "pg-1", parent_block_id: null, order_key: "a0", type: "text", props: { text: "hi" } }],
  vendors: [
    {
      id: "v-1",
      project_id: "p-1",
      name: "Acme Machining",
      category: "machining",
      contact_name: null,
      email: null,
      phone: null,
      website: null,
      location: "Tempe",
      processes: ["mill"],
      machining: null,
      lead_time_days: 10,
      status: "active",
      notes: null,
    },
  ],
  task_comments: [
    { id: "c-1", task_id: "t-1", author_id: "u-2", body: "looks good", kind: "general", created_at: "2026-03-02T00:00:00Z" },
    { id: "c-2", task_id: "t-3", author_id: null, body: "ok", kind: "drawing_review", created_at: "2026-03-03T00:00:00Z" },
  ],
  task_links: [
    { id: "l-1", task_id: "t-1", url: "https://example.com", label: "spec", created_at: "2026-03-02T00:00:00Z", created_by: "u-1" },
  ],
  build_records: [
    { task_id: "t-1", part_file: { name: "hoop.SLDPRT", present: true }, drawing_file: null, drawing_review: "pending" },
  ],
  calendar_events: [
    {
      id: "e-1",
      project_id: "p-1",
      title: "Design review",
      date: "2026-04-01",
      all_subteams: true,
      subteam_ids: [],
      type_tags: ["review"],
      description: null,
      recurrence: "none",
      recurrence_end: null,
    },
  ],
  activity: [
    {
      id: "a-1",
      project_id: "p-1",
      actor_id: "u-1",
      action: "updated",
      target_type: "task",
      target_id: "t-1",
      target_name: "Weld main hoop",
      subteam_ids: ["st-1"],
      payload: null,
      created_at: "2026-03-02T12:00:00Z",
    },
    {
      id: "a-2",
      project_id: "p-2",
      actor_id: "u-2",
      action: "created",
      target_type: "task",
      target_id: "t-3",
      target_name: "Rules review",
      subteam_ids: ["st-1"],
      payload: { foo: 1 },
      created_at: "2026-03-01T12:00:00Z",
    },
  ],
  project_hidden_subteams: [{ project_id: "p-1", subteam_id: "st-2" }],
  my_team_roles: [{ project_id: "p-1", team_role: "lead" }],
};

/**
 * A PostgREST-ish chainable stub: every filter/modifier returns itself and the
 * builder is thenable, so `await sb.from(t).select(...).order(...)` resolves to
 * `{ data, error }` exactly like supabase-js.
 */
function builder(data: unknown, calls: string[], error: { message: string } | null = null) {
  const self: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "eq", "is", "gt", "not"]) {
    self[m] = () => self;
  }
  self.in = (col: string, vals: unknown[]) => {
    calls.push(`in:${col}:${(vals ?? []).join(",")}`);
    return self;
  };
  self.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(res, rej);
  return self;
}

/** A client whose `pm` schema serves the fixture. `calls` records every read. */
export function stubClient(fixture: RawFixture = RAW_FIXTURE) {
  const calls: string[] = [];
  const tables = fixture as unknown as Record<string, Array<Record<string, unknown>>>;
  const sb = {
    from: (table: string) => {
      calls.push(`from:${table}`);
      return builder(tables[table] ?? [], calls);
    },
    rpc: (fn: string) => {
      calls.push(`rpc:${fn}`);
      return builder(tables[fn] ?? [], calls);
    },
  };
  const client = { schema: () => sb } as unknown as SupabaseClient;
  return { client, calls };
}
