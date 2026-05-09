import { describe, it, expect } from "vitest";
import { folderPath, localDestPath } from "../../src/modules/vault/data/folder-paths";

const folders = [
  { id: "f1", vault_id: "v", parent_id: null, name: "chassis", created_at: "x" },
  { id: "f2", vault_id: "v", parent_id: "f1", name: "frame", created_at: "x" },
  { id: "f3", vault_id: "v", parent_id: null, name: "powertrain", created_at: "x" },
];

describe("folderPath", () => {
  it("returns '' for null folder id", () => {
    expect(folderPath(null, folders as any)).toBe("");
  });

  it("returns single name for top-level folder", () => {
    expect(folderPath("f1", folders as any)).toBe("chassis");
  });

  it("walks parent chain for nested folders", () => {
    expect(folderPath("f2", folders as any)).toBe("chassis/frame");
  });

  it("returns '' when folder id not found", () => {
    expect(folderPath("missing", folders as any)).toBe("");
  });
});

describe("localDestPath", () => {
  it("joins vault root + folder path + file name", () => {
    expect(localDestPath("/Users/me/Vault", "f2", "rail.sldprt", folders as any))
      .toBe("/Users/me/Vault/chassis/frame/rail.sldprt");
  });

  it("places root files directly under the vault root", () => {
    expect(localDestPath("/Users/me/Vault", null, "readme.txt", folders as any))
      .toBe("/Users/me/Vault/readme.txt");
  });
});
