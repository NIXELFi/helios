import { describe, expect, it } from "vitest";
import { mergeRows } from "../useAllFiles";
import type { VaultFile } from "../types";

function file(id: string, over: Partial<VaultFile> = {}): VaultFile {
  return {
    id,
    vault_id: "v1",
    folder_id: "fo1",
    name: `${id}.sldprt`,
    latest_version_id: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

describe("mergeRows", () => {
  it("replaces a row by id, keeping list position", () => {
    // A folder-scoped read returns the folder's COMPLETE listing, so pass all
    // three rows back with one renamed.
    const cur = [file("a"), file("b"), file("c")];
    const next = mergeRows(cur, [file("a"), file("b", { name: "renamed.sldprt" }), file("c")], { folderId: "fo1" });
    expect(next.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(next[1]!.name).toBe("renamed.sldprt");
    // Untouched rows keep their identity so downstream memos don't churn.
    expect(next[0]).toBe(cur[0]);
    expect(next[2]).toBe(cur[2]);
  });

  it("appends rows it has never seen", () => {
    const cur = [file("a")];
    const next = mergeRows(cur, [file("a"), file("z")], { folderId: "fo1" });
    expect(next.map((f) => f.id)).toEqual(["a", "z"]);
  });

  it("removes rows of the scoped folder that the server no longer returns", () => {
    // `b` moved out of fo1 (or was soft-deleted): the folder query is the
    // authority for its own folder, so an absent row means it is gone.
    const cur = [file("a"), file("b"), file("c")];
    const next = mergeRows(cur, [file("a"), file("c")], { folderId: "fo1" });
    expect(next.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("never touches rows outside the scoped folder", () => {
    const cur = [file("a"), file("other", { folder_id: "fo2" }), file("root", { folder_id: null })];
    const next = mergeRows(cur, [file("a")], { folderId: "fo1" });
    expect(next.map((f) => f.id)).toEqual(["a", "other", "root"]);
  });

  it("scopes the vault root as folderId null", () => {
    const cur = [file("r1", { folder_id: null }), file("r2", { folder_id: null }), file("a")];
    const next = mergeRows(cur, [file("r1", { folder_id: null })], { folderId: null });
    expect(next.map((f) => f.id)).toEqual(["r1", "a"]);
  });

  it("an ids scope replaces and appends but removes nothing", () => {
    // The ids scope is used after a check-in: the requested ids that came back
    // are refreshed; an id the server did not return is NOT evidence of a
    // delete (RLS, another vault), and the liveFiles count covers real deletes.
    const cur = [file("a"), file("b")];
    const next = mergeRows(cur, [file("a", { name: "new.sldprt" })], { ids: ["a", "b"] });
    expect(next.map((f) => f.id)).toEqual(["a", "b"]);
    expect(next[0]!.name).toBe("new.sldprt");
  });

  it("returns the SAME array reference when nothing actually changed", () => {
    // Rows come back as fresh objects from PostgREST every time, so identity
    // alone can't answer this — equal content must be a no-op or every poll
    // would re-render the whole file table.
    const cur = [file("a"), file("b")];
    expect(mergeRows(cur, [file("a"), file("b")], { folderId: "fo1" })).toBe(cur);
    expect(mergeRows(cur, [], { ids: ["zz"] })).toBe(cur);
  });

  it("compares the embedded latest version, not just the file columns", () => {
    const cur = [file("a", { latest_version_id: "v1", latest: { id: "v1", version_num: 1 } as any })];
    const same = mergeRows(cur, [file("a", { latest_version_id: "v1", latest: { id: "v1", version_num: 1 } as any })], { ids: ["a"] });
    expect(same).toBe(cur);
    const moved = mergeRows(cur, [file("a", { latest_version_id: "v2", latest: { id: "v2", version_num: 2 } as any })], { ids: ["a"] });
    expect(moved).not.toBe(cur);
    expect(moved[0]!.latest!.id).toBe("v2");
  });
});
