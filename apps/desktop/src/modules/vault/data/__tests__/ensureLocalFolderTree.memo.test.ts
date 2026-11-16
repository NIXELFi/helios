// ensureLocalFolderTree memo (2026-11-16): an unchanged folder list for the
// same root is not re-mkdir'd within REMATERIALIZE_MS; a run where every mkdir
// failed is not remembered.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mkdir = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({ mkdir: (...a: unknown[]) => mkdir(...a) }));

import { ensureLocalFolderTree, REMATERIALIZE_MS } from "../ensureLocalFolderTree";

const folders = () => [
  { id: "a", name: "A", parent_id: null, vault_id: "v" },
  { id: "b", name: "B", parent_id: "a", vault_id: "v" },
] as never[];

beforeEach(() => { mkdir.mockReset(); mkdir.mockResolvedValue(undefined); });

describe("ensureLocalFolderTree memo", () => {
  it("skips an unchanged list for the same root, re-runs for a new list / root / after the TTL", async () => {
    const f = folders();
    await ensureLocalFolderTree(f, "/r");
    expect(mkdir).toHaveBeenCalledTimes(2);
    await ensureLocalFolderTree(f, "/r");
    expect(mkdir).toHaveBeenCalledTimes(2);
    await ensureLocalFolderTree(f, "/other");
    expect(mkdir).toHaveBeenCalledTimes(4);
    await ensureLocalFolderTree(folders(), "/r"); // new array = folders changed
    expect(mkdir).toHaveBeenCalledTimes(6);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + REMATERIALIZE_MS + 1);
    await ensureLocalFolderTree(f, "/other");
    expect(mkdir).toHaveBeenCalledTimes(8);
    spy.mockRestore();
  });

  it("does not remember a run where every mkdir failed", async () => {
    mkdir.mockRejectedValue(new Error("not ready"));
    const f = folders();
    await ensureLocalFolderTree(f, "/r");
    await ensureLocalFolderTree(f, "/r");
    expect(mkdir).toHaveBeenCalledTimes(4);
  });
});
