import { describe, expect, it, vi } from "vitest";
import { ensureFolderHierarchy } from "../useAddLocalFile";

/**
 * ensureFolderHierarchy (20260721000000 rework): existing live folders are
 * reused via the cheap table lookup; misses go through the pdm_create_folder
 * RPC (resurrect-or-create); and ONLY rows the RPC actually materialized
 * (created or resurrected) are reported back for the failure-path cleanup —
 * a race lost to another op's create must not mark that folder as ours.
 */

type FolderRow = { id: string; name: string; parent_id: string | null };

/** Awaitable supabase-js query-builder stub: chainable eq/is, resolves rows. */
function folderLookup(rowsFor: (name: string, parentId: string | null) => FolderRow[]) {
  return () => {
    const filters: Record<string, unknown> = {};
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      then: (resolve: (v: { data: FolderRow[]; error: null }) => void) =>
        resolve({
          data: rowsFor(filters["name"] as string, (filters["parent_id"] as string | null) ?? null),
          error: null,
        }),
    };
    return builder;
  };
}

it("reuses live folders without calling the RPC", async () => {
  const rpc = vi.fn();
  const client = {
    from: folderLookup((name) => (name === "Chassis" ? [{ id: "f1", name, parent_id: null }] : [])),
    rpc,
  };
  const r = await ensureFolderHierarchy(client, "vault-1", ["Chassis"]);
  expect(r.folderId).toBe("f1");
  expect(r.createdFolderIds).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
});

describe("on lookup miss", () => {
  it("creates via pdm_create_folder and tracks the chain deepest-last", async () => {
    let n = 0;
    const rpc = vi.fn(async (_fn: string, args: any) => ({
      data: { folder: { id: `new-${++n}` }, created: true, resurrected: false, name: args.p_name },
      error: null,
    }));
    const client = { from: folderLookup(() => []), rpc };
    const r = await ensureFolderHierarchy(client, "vault-1", ["A", "B"]);
    expect(r.folderId).toBe("new-2");
    expect(r.createdFolderIds).toEqual(["new-1", "new-2"]);
    expect(rpc).toHaveBeenNthCalledWith(1, "pdm_create_folder", {
      p_vault_id: "vault-1",
      p_parent_id: null,
      p_name: "A",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "pdm_create_folder", {
      p_vault_id: "vault-1",
      p_parent_id: "new-1",
      p_name: "B",
    });
  });

  it("counts a resurrected tombstone as ours, but not a lost create race", async () => {
    const results = [
      { folder: { id: "revived" }, created: false, resurrected: true },
      { folder: { id: "race-winner" }, created: false, resurrected: false },
    ];
    const rpc = vi.fn(async () => ({ data: results.shift(), error: null }));
    const client = { from: folderLookup(() => []), rpc };
    const r = await ensureFolderHierarchy(client, "vault-1", ["X", "Y"]);
    expect(r.folderId).toBe("race-winner");
    expect(r.createdFolderIds).toEqual(["revived"]);
  });

  it("surfaces an RPC failure with the segment name", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "editor or admin role required" } }));
    const client = { from: folderLookup(() => []), rpc };
    await expect(ensureFolderHierarchy(client, "vault-1", ["Nope"])).rejects.toThrow(
      /create folder "Nope": editor or admin role required/,
    );
  });
});
