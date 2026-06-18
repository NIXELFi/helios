import { describe, expect, it } from "vitest";
import {
  pmCursorKey,
  pmCursorChanged,
  fetchPmCursor,
  type PmCursor,
} from "../workspace-cursor";

function cur(p: Partial<PmCursor> = {}): PmCursor {
  return { tasks: 0, tasksUpdatedAt: "", activity: 0, taskOwners: 0, taskLinks: 0, ...p };
}

describe("pm workspace-cursor pure logic", () => {
  it("pmCursorKey is stable and distinguishes every field", () => {
    const a = cur({ tasks: 1, tasksUpdatedAt: "2026-06-06T00:00:00Z", activity: 4 });
    expect(pmCursorKey(a)).toBe(pmCursorKey({ ...a }));
    expect(pmCursorKey(cur({ tasks: 1 }))).not.toBe(pmCursorKey(cur({ tasks: 2 })));
    expect(pmCursorKey(cur({ tasksUpdatedAt: "a" }))).not.toBe(pmCursorKey(cur({ tasksUpdatedAt: "b" })));
    expect(pmCursorKey(cur({ activity: 1 }))).not.toBe(pmCursorKey(cur({ activity: 2 })));
    expect(pmCursorKey(cur({ taskOwners: 1 }))).not.toBe(pmCursorKey(cur({ taskOwners: 2 })));
    expect(pmCursorKey(cur({ taskLinks: 1 }))).not.toBe(pmCursorKey(cur({ taskLinks: 2 })));
  });

  it("first observation is a baseline, not a change", () => {
    expect(pmCursorChanged(null, cur({ tasks: 5 }))).toBe(false);
  });

  it("identical cursor is not a change", () => {
    const c = cur({ tasks: 5, tasksUpdatedAt: "t", activity: 9 });
    expect(pmCursorChanged(c, { ...c })).toBe(false);
  });

  it("detects a task edit (updated_at moves), a new/removed task (count), new activity, and owner/link churn", () => {
    const base = cur({ tasks: 5, tasksUpdatedAt: "2026-06-06T00:00:00Z", activity: 9 });
    expect(pmCursorChanged(base, { ...base, tasksUpdatedAt: "2026-06-06T00:05:00Z" })).toBe(true);
    expect(pmCursorChanged(base, { ...base, tasks: 6 })).toBe(true);
    expect(pmCursorChanged(base, { ...base, activity: 10 })).toBe(true);
    expect(pmCursorChanged(base, { ...base, taskOwners: 1 })).toBe(true);
    expect(pmCursorChanged(base, { ...base, taskLinks: 1 })).toBe(true);
  });
});

// Fake of the pm-schema query builder. `.schema("pm")` returns a builder
// factory; head-count selects resolve to { count }, the updated_at select
// resolves to { data: [{updated_at}] }. We record the schema + per-table calls
// so the test can assert correct scoping.
interface QState {
  table: string;
  select?: string;
  head: boolean;
  ordered?: [string, { ascending: boolean }];
  limited?: number;
}

function makePmClient(opts: {
  tasksCount: number;
  activityCount: number;
  tasksUpdatedAt: string | null;
  ownersCount?: number;
  linksCount?: number;
  errorTableHead?: string;
}) {
  const states: QState[] = [];
  let schemaUsed: string | null = null;
  const sb = {
    from(table: string) {
      const st: QState = { table, head: false };
      states.push(st);
      const b: Record<string, unknown> = {
        select(sel: string, o?: { count?: string; head?: boolean }) {
          st.select = sel;
          if (o?.head) st.head = true;
          return b;
        },
        order(col: string, o: { ascending: boolean }) {
          st.ordered = [col, o];
          return b;
        },
        limit(n: number) {
          st.limited = n;
          return b;
        },
        then(resolve: (r: unknown) => void) {
          if (st.head) {
            if (opts.errorTableHead === table) {
              return resolve({ count: null, error: new Error("boom") });
            }
            const count =
              table === "tasks"
                ? opts.tasksCount
                : table === "task_owners"
                  ? opts.ownersCount ?? 0
                  : table === "task_links"
                    ? opts.linksCount ?? 0
                    : opts.activityCount;
            return resolve({ count, error: null });
          }
          // the updated_at probe
          const data = opts.tasksUpdatedAt === null ? [] : [{ updated_at: opts.tasksUpdatedAt }];
          return resolve({ data, error: null });
        },
      };
      return b;
    },
  };
  const client = {
    schema(s: string) {
      schemaUsed = s;
      return sb;
    },
  } as never;
  return { client, states, schemaUsed: () => schemaUsed };
}

describe("fetchPmCursor", () => {
  it("reads the pm schema and returns the task/activity/owner/link signature", async () => {
    const h = makePmClient({
      tasksCount: 42,
      activityCount: 130,
      tasksUpdatedAt: "2026-06-06T01:00:00Z",
      ownersCount: 7,
      linksCount: 3,
    });
    const c = await fetchPmCursor(h.client);
    expect(c).toEqual({
      tasks: 42,
      tasksUpdatedAt: "2026-06-06T01:00:00Z",
      activity: 130,
      taskOwners: 7,
      taskLinks: 3,
    });
    expect(h.schemaUsed()).toBe("pm");

    const heads = h.states.filter((s) => s.head).map((s) => s.table).sort();
    expect(heads).toEqual(["activity", "task_links", "task_owners", "tasks"]);
    const upd = h.states.find((s) => s.table === "tasks" && !s.head)!;
    expect(upd.select).toContain("updated_at");
    expect(upd.ordered).toEqual(["updated_at", { ascending: false }]);
    expect(upd.limited).toBe(1);
  });

  it("treats an empty tasks table as an empty updated_at marker", async () => {
    const h = makePmClient({ tasksCount: 0, activityCount: 0, tasksUpdatedAt: null });
    const c = await fetchPmCursor(h.client);
    expect(c).toEqual({ tasks: 0, tasksUpdatedAt: "", activity: 0, taskOwners: 0, taskLinks: 0 });
  });

  it("throws if a sub-query errors so the caller falls back to a full refresh", async () => {
    const h = makePmClient({ tasksCount: 1, activityCount: 1, tasksUpdatedAt: "t", errorTableHead: "activity" });
    await expect(fetchPmCursor(h.client)).rejects.toThrow();
  });
});
