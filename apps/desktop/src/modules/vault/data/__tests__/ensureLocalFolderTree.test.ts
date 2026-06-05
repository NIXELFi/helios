import { describe, expect, it } from "vitest";
import { localFolderPaths } from "../ensureLocalFolderTree";
import type { Folder } from "../types";

function folder(id: string, parent_id: string | null, name: string): Folder {
  return { id, vault_id: "v1", parent_id, name, created_at: "2026-01-01" };
}

describe("localFolderPaths", () => {
  it("produces root/parent/child absolute paths for nested folders", () => {
    const folders: Folder[] = [
      folder("p", null, "Chassis"),
      folder("c", "p", "Frame"),
    ];
    const paths = localFolderPaths(folders, "/vault");
    expect(paths).toContain("/vault/Chassis");
    expect(paths).toContain("/vault/Chassis/Frame");
  });

  it("sanitizes traversal names so a folder can't escape root", () => {
    const folders: Folder[] = [folder("x", null, "..")];
    const paths = localFolderPaths(folders, "/vault");
    // folderPath sanitizes ".." → "__" so the path can never walk up.
    expect(paths).toEqual(["/vault/__"]);
    expect(paths[0]!.includes("/..")).toBe(false);
  });

  it("maps exactly what it's given (callers pre-filter deleted folders)", () => {
    const folders: Folder[] = [
      folder("a", null, "A"),
      folder("b", null, "B"),
    ];
    const paths = localFolderPaths(folders, "/root");
    expect(paths).toHaveLength(2);
    expect(paths.sort()).toEqual(["/root/A", "/root/B"]);
  });
});
