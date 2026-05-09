import { describe, it, expect } from "vitest";
import { matchLocal } from "../../src/modules/vault/data/local-match";

const file = {
  id: "f1",
  vault_id: "v",
  folder_id: null,
  name: "frame.sldprt",
  latest_version_id: "v1",
  created_at: "x",
};

describe("matchLocal", () => {
  it("returns no-folder when local list is null", () => {
    expect(matchLocal(file as any, null, new Map())).toEqual({ status: "no-folder" });
  });

  it("returns vault-only when no local file matches", () => {
    expect(matchLocal(file as any, [], new Map()).status).toBe("vault-only");
  });

  it("returns synced when local sha matches latest version sha", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    const versions = new Map([["f1", [{ id: "v1", file_id: "f1", version_num: 1, sha256: "abc", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" }] as any]]);
    expect(matchLocal(file as any, localFiles, versions).status).toBe("synced");
  });

  it("returns modified when local sha differs from latest", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    const versions = new Map([["f1", [{ id: "v1", file_id: "f1", version_num: 1, sha256: "different", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" }] as any]]);
    expect(matchLocal(file as any, localFiles, versions).status).toBe("modified");
  });

  it("returns modified when vault file has no versions yet (local is a candidate first version)", () => {
    const localFiles = [{ basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x", sha256: "abc", sizeBytes: 1 }];
    expect(matchLocal(file as any, localFiles, new Map()).status).toBe("modified");
  });
});
