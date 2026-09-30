import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cursorKey,
  cursorChanged,
  fetchVaultCursor,
  fetchVaultCursorLegacy,
  type VaultCursor,
} from "../vault-cursor";

function cur(p: Partial<VaultCursor> = {}): VaultCursor {
  return { liveFiles: 0, versions: 0, liveFolders: 0, activeLocks: 0, ...p };
}

describe("vault-cursor pure logic", () => {
  it("cursorKey is stable and distinguishes every field", () => {
    const a = cur({ liveFiles: 1, versions: 2, liveFolders: 3, activeLocks: 4 });
    const b = cur({ liveFiles: 1, versions: 2, liveFolders: 3, activeLocks: 4 });
    expect(cursorKey(a)).toBe(cursorKey(b));
    expect(cursorKey(cur({ liveFiles: 1 }))).not.toBe(cursorKey(cur({ liveFiles: 2 })));
    expect(cursorKey(cur({ versions: 1 }))).not.toBe(cursorKey(cur({ versions: 2 })));
    expect(cursorKey(cur({ liveFolders: 1 }))).not.toBe(cursorKey(cur({ liveFolders: 2 })));
    expect(cursorKey(cur({ activeLocks: 1 }))).not.toBe(cursorKey(cur({ activeLocks: 2 })));
  });

  it("first observation (no previous) is a baseline, not a change", () => {
    // The poll establishes a baseline on first run; it must NOT trigger a full
    // reconcile on mount or every newly-opened vault would re-pull immediately.
    expect(cursorChanged(null, cur({ liveFiles: 5 }))).toBe(false);
  });

  it("an identical cursor is not a change", () => {
    const c = cur({ liveFiles: 5, versions: 3, liveFolders: 2, activeLocks: 1 });
    expect(cursorChanged(c, { ...c })).toBe(false);
  });

  it("any differing count is a change", () => {
    const base = cur({ liveFiles: 5, versions: 3, liveFolders: 2, activeLocks: 1 });
    // new file added / file soft-deleted / restored — liveFiles moves
    expect(cursorChanged(base, { ...base, liveFiles: 6 })).toBe(true);
    // someone checked in — a new version row
    expect(cursorChanged(base, { ...base, versions: 4 })).toBe(true);
    // folder created / deleted / restored
    expect(cursorChanged(base, { ...base, liveFolders: 3 })).toBe(true);
    // lock acquired / released
    expect(cursorChanged(base, { ...base, activeLocks: 0 })).toBe(true);
  });
});

// Minimal fake of the supabase-js query builder: every filter method returns
// `this`, and awaiting the builder resolves to a PostgREST-style { count, error }.
// We record the table, select string, options and applied filters so the test
// can assert the probe is correctly scoped (this is exactly where a wrong
// filter would silently break the safety net).
interface QState {
  table: string;
  select?: string;
  opts?: { count?: string; head?: boolean };
  filters: Array<[string, ...unknown[]]>;
}

function makeCountClient(counts: Record<string, number>, errorOn?: string) {
  const states: QState[] = [];
  const from = (table: string) => {
    const st: QState = { table, filters: [] };
    states.push(st);
    const b: Record<string, unknown> = {
      select(sel: string, opts: QState["opts"]) {
        st.select = sel;
        st.opts = opts;
        return b;
      },
      eq(c: string, v: unknown) {
        st.filters.push(["eq", c, v]);
        return b;
      },
      is(c: string, v: unknown) {
        st.filters.push(["is", c, v]);
        return b;
      },
      not(c: string, op: string, v: unknown) {
        st.filters.push(["not", c, op, v]);
        return b;
      },
      then(resolve: (r: { count: number | null; error: Error | null }) => void) {
        if (errorOn === table) return resolve({ count: null, error: new Error("boom") });
        return resolve({ count: counts[table] ?? 0, error: null });
      },
    };
    return b;
  };
  return { client: { from } as never, states };
}

// The legacy four-count path. It is no longer what the app calls first (that
// is the pdm.vault_cursor RPC below), but it stays the fallback for a database
// that predates the RPC migration, so its scoping still has to be exactly
// right — including the FK-naming regression at the bottom of this block.
describe("fetchVaultCursorLegacy", () => {
  it("returns the four scoped counts", async () => {
    const { client } = makeCountClient({ files: 100, versions: 250, folders: 12, locks: 3 });
    const c = await fetchVaultCursorLegacy(client, "v1");
    expect(c).toEqual({ liveFiles: 100, versions: 250, liveFolders: 12, activeLocks: 3 });
  });

  it("scopes each count correctly with head-only counts (near-zero egress)", async () => {
    const { client, states } = makeCountClient({ files: 1, versions: 1, folders: 1, locks: 1 });
    await fetchVaultCursorLegacy(client, "v1");

    const files = states.find((s) => s.table === "files")!;
    expect(files.opts).toMatchObject({ count: "exact", head: true });
    expect(files.filters).toContainEqual(["eq", "vault_id", "v1"]);
    expect(files.filters).toContainEqual(["is", "deleted_at", null]);

    // versions has no vault_id column — must scope via an inner join on files,
    // naming the FK explicitly (see the dedicated regression test below).
    const versions = states.find((s) => s.table === "versions")!;
    expect(versions.opts).toMatchObject({ count: "exact", head: true });
    expect(versions.select).toContain("files!versions_file_id_fkey!inner");
    expect(versions.filters).toContainEqual(["eq", "files.vault_id", "v1"]);

    const folders = states.find((s) => s.table === "folders")!;
    expect(folders.filters).toContainEqual(["eq", "vault_id", "v1"]);
    expect(folders.filters).toContainEqual(["is", "deleted_at", null]);

    // locks have no vault_id column — must scope via an inner join on files so
    // a lock change in another vault doesn't move this vault's signature.
    const locks = states.find((s) => s.table === "locks")!;
    expect(locks.opts).toMatchObject({ count: "exact", head: true });
    expect(locks.select).toContain("files!inner");
    expect(locks.filters).toContainEqual(["eq", "files.vault_id", "v1"]);
    expect(locks.filters).toContainEqual(["is", "released_at", null]);
  });

  it("throws if any sub-count errors so the caller can fall back to a full reconcile", async () => {
    const { client } = makeCountClient({ files: 1, versions: 1, folders: 1, locks: 1 }, "versions");
    await expect(fetchVaultCursorLegacy(client, "v1")).rejects.toThrow();
  });

  // Regression (shipped v4.1.1 -> v5.3.1): the versions probe embedded a bare
  // `files!inner`. pdm.files and pdm.versions reference each other BOTH ways
  // (versions.file_id -> files.id, files.latest_version_id -> versions.id), so
  // PostgREST could not choose a relationship and answered 300 / PGRST201 —
  // BEFORE RLS, which is why this one count failed while the other three passed.
  // countOf throws on error, Promise.all rejected, and useVaultCursor's catch ran
  // a full catalog reconcile on EVERY 15s tick, for every open Browse tab. The
  // whole point of the cursor probe (avoid megabyte re-pulls on an idle vault)
  // was inverted into a permanent full-pull loop.
  //
  // A mock can't reproduce PostgREST's relationship resolution, so this asserts
  // the one thing that actually prevents it: the embed names the FK. `locks` is
  // deliberately checked to be WITHOUT a hint — it has a single FK to files, and
  // adding a bogus constraint name there would break it the same way.
  it("names the FK on the versions embed (ambiguous otherwise) but not on locks", async () => {
    const { client, states } = makeCountClient({ files: 1, versions: 1, folders: 1, locks: 1 });
    await fetchVaultCursorLegacy(client, "v1");

    const versions = states.find((s) => s.table === "versions")!;
    expect(versions.select).toContain("files!versions_file_id_fkey!inner");
    // The bare form is the bug — it must not come back.
    expect(versions.select).not.toMatch(/files!inner/);

    const locks = states.find((s) => s.table === "locks")!;
    expect(locks.select).toContain("files!inner");
    expect(locks.select).not.toMatch(/files!\w+!inner/);
  });
});

// ── the pdm.vault_cursor RPC path ────────────────────────────────────────────
// One request instead of four, and the counts run as the definer so RLS never
// evaluates pdm.is_member_in per row (measured in prod: 1,434 ms -> 11 ms for
// the versions count alone). Every test here re-imports the module so the
// module-scope "the RPC is missing" latch starts fresh.
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function makeRpcClient(rpcResults: RpcResult[], counts: Record<string, number> = {}) {
  const rpcCalls: Array<[string, unknown]> = [];
  const tables: string[] = [];
  const client = {
    rpc(fn: string, args: unknown) {
      rpcCalls.push([fn, args]);
      const r = rpcResults.shift() ?? { data: [], error: null };
      return { then: (resolve: (v: RpcResult) => void) => resolve(r) };
    },
    from(table: string) {
      tables.push(table);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        then: (resolve: (r: { count: number; error: null }) => void) =>
          resolve({ count: counts[table] ?? 0, error: null }),
      };
      return b;
    },
  } as never;
  return { client, rpcCalls, tables };
}

async function freshModule() {
  vi.resetModules();
  return await import("../vault-cursor");
}

describe("fetchVaultCursor (RPC)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls pdm.vault_cursor once and maps its row onto the cursor", async () => {
    const m = await freshModule();
    const h = makeRpcClient([
      {
        data: [{ live_files: 8627, versions: 8688, live_folders: 812, active_locks: 3 }],
        error: null,
      },
    ]);
    const c = await m.fetchVaultCursor(h.client, "v1");
    expect(c).toEqual({ liveFiles: 8627, versions: 8688, liveFolders: 812, activeLocks: 3 });
    expect(h.rpcCalls).toEqual([["vault_cursor", { p_vault_id: "v1" }]]);
    // The whole point: no per-table count requests.
    expect(h.tables).toEqual([]);
  });

  it("accepts a single-object payload as well as a one-row array", async () => {
    const m = await freshModule();
    const h = makeRpcClient([
      { data: { live_files: 1, versions: 2, live_folders: 3, active_locks: 4 }, error: null },
    ]);
    expect(await m.fetchVaultCursor(h.client, "v1")).toEqual({
      liveFiles: 1,
      versions: 2,
      liveFolders: 3,
      activeLocks: 4,
    });
  });

  it("falls back to the four counts when the function is missing, and remembers it", async () => {
    const m = await freshModule();
    const h = makeRpcClient(
      [{ data: null, error: { code: "PGRST202", message: "Could not find the function pdm.vault_cursor" } }],
      { files: 5, versions: 7, folders: 2, locks: 1 },
    );
    expect(await m.fetchVaultCursor(h.client, "v1")).toEqual({
      liveFiles: 5,
      versions: 7,
      liveFolders: 2,
      activeLocks: 1,
    });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.tables.sort()).toEqual(["files", "folders", "locks", "versions"]);

    // A database without the migration must not pay for a doomed RPC request
    // on every 15s tick, so the second call skips straight to the counts.
    await m.fetchVaultCursor(h.client, "v1");
    expect(h.rpcCalls).toHaveLength(1);
  });

  it("also recognises the 42883 / 'does not exist' wording as missing", async () => {
    const m = await freshModule();
    const h = makeRpcClient(
      [{ data: null, error: { code: "42883", message: "function pdm.vault_cursor(uuid) does not exist" } }],
      { files: 1, versions: 1, folders: 1, locks: 1 },
    );
    await m.fetchVaultCursor(h.client, "v1");
    expect(h.tables).toHaveLength(4);
  });

  it("throws on any other RPC error so the caller runs a full reconcile", async () => {
    const m = await freshModule();
    const h = makeRpcClient([{ data: null, error: { code: "500", message: "boom" } }], {
      files: 1,
      versions: 1,
      folders: 1,
      locks: 1,
    });
    await expect(m.fetchVaultCursor(h.client, "v1")).rejects.toThrow(/boom/);
    // NOT a fallback: an outage must not silently downgrade every client to
    // the expensive path for the rest of the session.
    expect(h.tables).toEqual([]);
  });

  it("throws when the RPC returns no row at all", async () => {
    const m = await freshModule();
    const h = makeRpcClient([{ data: [], error: null }]);
    await expect(m.fetchVaultCursor(h.client, "v1")).rejects.toThrow(/no row/i);
  });
});
