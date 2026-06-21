// Tests for the vault-bulk shared helpers.
// These are pure-function tests — no React, no Supabase connection.
// The client mock is minimal: just enough to let fetchByIdsChunked / fetchLatestVersionProperties
// resolve without a real DB.

import { describe, it, expect, vi } from "vitest";
import {
  chunkIds,
  fetchByIdsChunked,
  fetchLatestVersionProperties,
} from "../vault-bulk";
import type { SwProperty } from "../types";

// ---------------------------------------------------------------------------
// chunkIds — pure split helper
// ---------------------------------------------------------------------------

describe("chunkIds", () => {
  it("returns an empty array when given an empty list", () => {
    expect(chunkIds([], 300)).toEqual([]);
  });

  it("returns a single chunk when the list is exactly chunkSize", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids, 300);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(300);
  });

  it("returns a single chunk when the list is shorter than chunkSize", () => {
    const ids = ["a", "b", "c"];
    const chunks = chunkIds(ids, 300);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(["a", "b", "c"]);
  });

  it("splits 301 ids into [300, 1] with chunkSize=300", () => {
    const ids = Array.from({ length: 301 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids, 300);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(300);
    expect(chunks[1]).toHaveLength(1);
  });

  it("splits 900 ids into three chunks of 300 with chunkSize=300", () => {
    const ids = Array.from({ length: 900 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids, 300);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk).toHaveLength(300);
  });

  it("preserves every id without duplication or loss", () => {
    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids, 300);
    const merged = chunks.flat();
    expect(merged).toHaveLength(750);
    expect(new Set(merged).size).toBe(750);
    expect(merged).toEqual(ids);
  });

  it("uses 300 as the default chunk size", () => {
    const ids = Array.from({ length: 301 }, (_, i) => `id-${i}`);
    // call without explicit chunkSize — should still split at 300
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// fetchByIdsChunked — queries the client in batches, merges results
// ---------------------------------------------------------------------------

/** Build a minimal Supabase-like client mock that records calls and returns
 *  the provided rows for any .in() query. */
function makeMockClient(rowsByChunk: Record<string, unknown>[][]) {
  let callCount = 0;
  const calls: string[][] = [];

  const builder = {
    in: vi.fn((col: string, ids: string[]) => {
      calls.push(ids);
      const rows = rowsByChunk[callCount] ?? [];
      callCount++;
      return Promise.resolve({ data: rows, error: null });
    }),
    select: vi.fn(() => builder),
  };

  const client = {
    from: vi.fn(() => builder),
    _calls: calls,
  };

  return client;
}

describe("fetchByIdsChunked", () => {
  it("makes no query and returns [] when ids list is empty", async () => {
    const client = makeMockClient([]);
    const result = await fetchByIdsChunked(client as any, "versions", "file_id,properties", []);
    expect(result).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("makes exactly one query when ids fit in a single chunk (< chunkSize)", async () => {
    const rows = [{ file_id: "f1", properties: null }];
    const client = makeMockClient([rows]);
    const result = await fetchByIdsChunked(client as any, "versions", "file_id,properties", ["v1", "v2"], "id", 300);
    expect(result).toEqual(rows);
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("splits >chunkSize ids into multiple queries and merges results", async () => {
    const chunk1 = [{ file_id: "f1", properties: null }, { file_id: "f2", properties: null }];
    const chunk2 = [{ file_id: "f3", properties: null }];
    // 3 total ids, chunkSize=2 → 2 queries
    const client = makeMockClient([chunk1, chunk2]);
    const ids = ["v1", "v2", "v3"];
    const result = await fetchByIdsChunked(client as any, "versions", "file_id,properties", ids, "id", 2);
    expect(result).toHaveLength(3);
    expect(result).toEqual([...chunk1, ...chunk2]);
  });

  it("throws when any chunk query returns an error", async () => {
    const builder = {
      in: vi.fn().mockResolvedValue({ data: null, error: { message: "db error" } }),
      select: vi.fn(),
    };
    builder.select.mockReturnValue(builder);
    const client = { from: vi.fn().mockReturnValue(builder) };

    await expect(
      fetchByIdsChunked(client as any, "versions", "file_id,properties", ["v1"], "id", 300),
    ).rejects.toThrow("db error");
  });

  it("matches against a custom column (e.g. parent_version_id for refs, not id)", async () => {
    // Regression: the BOM refs query fetches refs WHERE parent_version_id IN (...),
    // not WHERE id IN (...). fetchByIdsChunked must honor the column argument.
    const captured: string[] = [];
    const builder: any = {
      select: vi.fn(() => builder),
      in: vi.fn((col: string, _ids: string[]) => {
        captured.push(col);
        return Promise.resolve({ data: [], error: null });
      }),
    };
    const client = { from: vi.fn(() => builder) };
    await fetchByIdsChunked(
      client as any,
      "refs",
      "parent_version_id,child_file_id",
      ["v1", "v2"],
      "parent_version_id",
    );
    expect(captured).toEqual(["parent_version_id"]);
  });
});

// ---------------------------------------------------------------------------
// fetchLatestVersionProperties — builds Map<fileId, SwProperty[]>
// ---------------------------------------------------------------------------

describe("fetchLatestVersionProperties", () => {
  it("returns an empty Map when files list is empty", async () => {
    const client = makeMockClient([]);
    const result = await fetchLatestVersionProperties(client as any, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("returns an empty Map when no file has a latest_version_id", async () => {
    const files = [
      { id: "f1", latest_version_id: null },
      { id: "f2", latest_version_id: null },
    ];
    const client = makeMockClient([]);
    const result = await fetchLatestVersionProperties(client as any, files);
    expect(result.size).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("maps file_id → SwProperty[] from version rows", async () => {
    const props: SwProperty[] = [{ name: "Mass", value: "1.2 kg" }];
    const rows = [{ file_id: "f1", properties: props }];
    const client = makeMockClient([rows]);
    const files = [{ id: "f1", latest_version_id: "v1" }];
    const result = await fetchLatestVersionProperties(client as any, files);
    expect(result.get("f1")).toEqual(props);
  });

  it("returns null (absent key) for files whose version row has null properties", async () => {
    const rows = [{ file_id: "f1", properties: null }];
    const client = makeMockClient([rows]);
    const files = [{ id: "f1", latest_version_id: "v1" }];
    const result = await fetchLatestVersionProperties(client as any, files);
    // null properties → key not set (caller gets undefined, treated as no props)
    expect(result.has("f1")).toBe(false);
  });

  it("chunks version ID queries when >chunkSize files exist", async () => {
    // 3 files, chunkSize=2 → 2 queries
    const chunk1 = [
      { file_id: "f1", properties: [{ name: "P", value: "1" }] as SwProperty[] },
      { file_id: "f2", properties: [{ name: "P", value: "2" }] as SwProperty[] },
    ];
    const chunk2 = [{ file_id: "f3", properties: [{ name: "P", value: "3" }] as SwProperty[] }];
    const client = makeMockClient([chunk1, chunk2]);
    const files = [
      { id: "f1", latest_version_id: "v1" },
      { id: "f2", latest_version_id: "v2" },
      { id: "f3", latest_version_id: "v3" },
    ];
    const result = await fetchLatestVersionProperties(client as any, files, 2);
    expect(result.size).toBe(3);
    expect(result.get("f1")).toEqual([{ name: "P", value: "1" }]);
    expect(result.get("f3")).toEqual([{ name: "P", value: "3" }]);
    expect(client.from).toHaveBeenCalledTimes(2);
  });
});
