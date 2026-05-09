import { describe, it, expect } from "vitest";
import { matchLocal, vaultRelativePath } from "../../src/modules/vault/data/local-match";

const file = {
  id: "f1",
  vault_id: "v",
  folder_id: null,
  name: "frame.sldprt",
  latest_version_id: "v1",
  created_at: "x",
};

const fileInFolder = {
  id: "f2",
  vault_id: "v",
  folder_id: "fold1",
  name: "frame.sldprt",
  latest_version_id: null,
  created_at: "x",
};

const folders = [
  { id: "fold1", vault_id: "v", parent_id: null, name: "chassis", created_at: "x" },
  { id: "fold2", vault_id: "v", parent_id: "fold1", name: "subframe", created_at: "x" },
];

describe("vaultRelativePath", () => {
  it("returns just filename for root files (no folder)", () => {
    expect(vaultRelativePath(file as any, [])).toBe("frame.sldprt");
  });

  it("returns folder/filename for files in a folder", () => {
    expect(vaultRelativePath(fileInFolder as any, folders as any)).toBe("chassis/frame.sldprt");
  });

  it("returns nested path for files in sub-folders", () => {
    const deepFile = { ...fileInFolder, id: "f3", folder_id: "fold2" };
    expect(vaultRelativePath(deepFile as any, folders as any)).toBe("chassis/subframe/frame.sldprt");
  });
});

describe("matchLocal", () => {
  it("returns no-folder when local list is null", () => {
    expect(matchLocal(file as any, null, new Map(), [])).toEqual({ status: "no-folder" });
  });

  it("returns vault-only when no local file matches", () => {
    expect(matchLocal(file as any, [], new Map(), []).status).toBe("vault-only");
  });

  it("returns synced when local sha matches latest version sha", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    const versions = new Map([["f1", [{ id: "v1", file_id: "f1", version_num: 1, sha256: "abc", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" }] as any]]);
    expect(matchLocal(file as any, localFiles, versions, []).status).toBe("synced");
  });

  it("returns modified when local sha differs from latest", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    const versions = new Map([["f1", [{ id: "v1", file_id: "f1", version_num: 1, sha256: "different", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" }] as any]]);
    expect(matchLocal(file as any, localFiles, versions, []).status).toBe("modified");
  });

  it("returns modified when vault file has no versions yet (local is a candidate first version)", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    expect(matchLocal(file as any, localFiles, new Map(), []).status).toBe("modified");
  });

  it("does NOT false-match a same-named file in a different folder", () => {
    // fileInFolder expects "chassis/frame.sldprt" but we only have root "frame.sldprt"
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    expect(matchLocal(fileInFolder as any, localFiles, new Map(), folders as any).status).toBe("vault-only");
  });

  it("matches correctly when local file is at the expected folder path", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "chassis/frame.sldprt", absolutePath: "/x/chassis/frame.sldprt", sha256: "abc", sizeBytes: 1 }];
    expect(matchLocal(fileInFolder as any, localFiles, new Map(), folders as any).status).toBe("modified");
  });

  // Backwards-compatible: folders param defaults to [] when omitted
  it("works without explicit folders arg (root-level files)", () => {
    expect(matchLocal(file as any, [], new Map()).status).toBe("vault-only");
  });
});
