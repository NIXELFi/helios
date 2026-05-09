import { describe, it, expect } from "vitest";
import { findUnmatchedLocal } from "../../src/modules/vault/data/find-unmatched";

const folders = [
  { id: "fold1", vault_id: "v", parent_id: null, name: "chassis", created_at: "x" },
];

const vaultFiles = [
  { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: null, created_at: "x" },
  { id: "f2", vault_id: "v", folder_id: "fold1", name: "bracket.sldprt", latest_version_id: null, created_at: "x" },
];

const localFrame = { basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/v/frame.sldprt", sha256: "a", sizeBytes: 1 };
const localBracket = { basename: "bracket.sldprt", relativePath: "chassis/bracket.sldprt", absolutePath: "/v/chassis/bracket.sldprt", sha256: "b", sizeBytes: 1 };
const localNew = { basename: "new-part.sldprt", relativePath: "new-part.sldprt", absolutePath: "/v/new-part.sldprt", sha256: "c", sizeBytes: 1 };

describe("findUnmatchedLocal", () => {
  it("returns empty when all local files match vault files", () => {
    const result = findUnmatchedLocal(vaultFiles as any, [localFrame, localBracket], folders as any);
    expect(result).toHaveLength(0);
  });

  it("returns only unmatched local files when some have no vault entry", () => {
    const result = findUnmatchedLocal(vaultFiles as any, [localFrame, localBracket, localNew], folders as any);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("new-part.sldprt");
  });

  it("returns empty when local list is empty", () => {
    const result = findUnmatchedLocal(vaultFiles as any, [], folders as any);
    expect(result).toHaveLength(0);
  });
});
