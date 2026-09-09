import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pmCursorKey,
  pmCursorChanged,
  fetchPmCursor,
  fetchPmCursorLegacy,
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

describe("fetchPmCursorLegacy", () => {
  it("reads the pm schema and returns the task/activity/owner/link signature", async () => {
    const h = makePmClient({
      tasksCount: 42,
      activityCount: 130,
      tasksUpdatedAt: "2026-06-06T01:00:00Z",
      ownersCount: 7,
      linksCount: 3,
    });
    const c = await fetchPmCursorLegacy(h.client);
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
    const c = await fetchPmCursorLegacy(h.client);
    expect(c).toEqual({ tasks: 0, tasksUpdatedAt: "", activity: 0, taskOwners: 0, taskLinks: 0 });
  });

  it("throws if a sub-query errors so the caller falls back to a full refresh", async () => {
    const h = makePmClient({ tasksCount: 1, activityCount: 1, tasksUpdatedAt: "t", errorTableHead: "activity" });
    await expect(fetchPmCursorLegacy(h.client)).rejects.toThrow();
  });
});

// ── the pm.workspace_cursor RPC path ─────────────────────────────────────────
// One request instead of five, with pm.can_read_pm evaluated once instead of
// once per row (prod: 13.3% of all database time went on these five probes).
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function makeRpcPmClient(rpcResults: RpcResult[], counts?: Parameters<typeof makePmClient>[0]) {
  const rpcCalls: string[] = [];
  const legacy = counts ? makePmClient(counts) : null;
  const client = {
    schema(s: string) {
      const base: Record<string, unknown> = {
        rpc(fn: string) {
          rpcCalls.push(`${s}.${fn}`);
          const r = rpcResults.shift() ?? { data: [], error: null };
          return { then: (resolve: (v: RpcResult) => void) => resolve(r) };
        },
        from(table: string) {
          if (!legacy) throw new Error("unexpected legacy request");
          return (legacy.client as any).schema("pm").from(table);
        },
      };
      return base;
    },
  } as never;
  return { client, rpcCalls, legacyStates: () => legacy?.states ?? [] };
}

async function freshPmModule() {
  vi.resetModules();
  return await import("../workspace-cursor");
}

describe("fetchPmCursor (RPC)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls pm.workspace_cursor once and maps its row", async () => {
    const m = await freshPmModule();
    const h = makeRpcPmClient([
      {
        data: [
          {
            tasks: 420,
            tasks_updated_at: "2026-09-09T12:00:00+00:00",
            activity: 797,
            task_owners: 327,
            task_links: 12,
          },
        ],
        error: null,
      },
    ]);
    expect(await m.fetchPmCursor(h.client)).toEqual({
      tasks: 420,
      tasksUpdatedAt: "2026-09-09T12:00:00+00:00",
      activity: 797,
      taskOwners: 327,
      taskLinks: 12,
    });
    expect(h.rpcCalls).toEqual(["pm.workspace_cursor"]);
  });

  it("treats a null max(updated_at) as the empty marker", async () => {
    const m = await freshPmModule();
    const h = makeRpcPmClient([
      { data: [{ tasks: 0, tasks_updated_at: null, activity: 0, task_owners: 0, task_links: 0 }], error: null },
    ]);
    expect((await m.fetchPmCursor(h.client)).tasksUpdatedAt).toBe("");
  });

  it("reads zero rows (a non-member) as 'no access, nothing changed'", async () => {
    // The RPC's WHERE clause returns NO ROW for a user who fails can_read_pm.
    // That is exactly what RLS gave the old counts (zeros), so the signature
    // must stay stable rather than throw and trigger a full refresh loop.
    const m = await freshPmModule();
    const h = makeRpcPmClient([{ data: [], error: null }]);
    expect(await m.fetchPmCursor(h.client)).toEqual({
      tasks: 0,
      tasksUpdatedAt: "",
      activity: 0,
      taskOwners: 0,
      taskLinks: 0,
    });
  });

  it("falls back to the five requests when the function is missing, and remembers it", async () => {
    const m = await freshPmModule();
    const h = makeRpcPmClient(
      [{ data: null, error: { code: "PGRST202", message: "Could not find the function pm.workspace_cursor" } }],
      { tasksCount: 5, activityCount: 6, tasksUpdatedAt: "2026-06-06T00:00:00Z", ownersCount: 2, linksCount: 1 },
    );
    expect(await m.fetchPmCursor(h.client)).toEqual({
      tasks: 5,
      tasksUpdatedAt: "2026-06-06T00:00:00Z",
      activity: 6,
      taskOwners: 2,
      taskLinks: 1,
    });
    expect(h.rpcCalls).toHaveLength(1);
    const after = h.legacyStates().length;
    expect(after).toBeGreaterThan(0);

    await m.fetchPmCursor(h.client);
    expect(h.rpcCalls).toHaveLength(1); // latched: no second doomed RPC
    expect(h.legacyStates().length).toBe(after * 2);
  });

  it("throws on any other RPC error so the caller runs a full refresh", async () => {
    const m = await freshPmModule();
    const h = makeRpcPmClient([{ data: null, error: { code: "500", message: "boom" } }]);
    await expect(m.fetchPmCursor(h.client)).rejects.toThrow(/boom/);
  });
});
