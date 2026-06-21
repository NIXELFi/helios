import { describe, it, expect } from "vitest";
import { filterWhereUsedToLatest } from "../useReferences";

// Minimal shapes the helper cares about
type RefRow = { parent_version_id: string };
type VersionRow = { id: string; file_id: string };
type FileRow = { id: string; name: string; latest_version_id: string | null; deleted_at?: string | null };

function makeVersionsById(rows: VersionRow[]): Map<string, VersionRow> {
  return new Map(rows.map((v) => [v.id, v]));
}
function makeFilesById(rows: FileRow[]): Map<string, FileRow> {
  return new Map(rows.map((f) => [f.id, f]));
}

describe("filterWhereUsedToLatest", () => {
  it("(a) includes a parent whose ref version equals its file's latest_version_id", () => {
    const refs: RefRow[] = [{ parent_version_id: "ver-1" }];
    const versionsById = makeVersionsById([{ id: "ver-1", file_id: "file-A" }]);
    const filesById = makeFilesById([
      { id: "file-A", name: "Assembly.SLDASM", latest_version_id: "ver-1", deleted_at: null },
    ]);
    const result = filterWhereUsedToLatest(refs, versionsById, filesById);
    expect(result).toHaveLength(1);
    expect(result[0]!.parentFileId).toBe("file-A");
    expect(result[0]!.parentVersionId).toBe("ver-1");
    expect(result[0]!.parentName).toBe("Assembly.SLDASM");
  });

  it("(b) excludes a parent whose ref points to an old version (!= latest_version_id)", () => {
    const refs: RefRow[] = [{ parent_version_id: "ver-old" }];
    const versionsById = makeVersionsById([{ id: "ver-old", file_id: "file-B" }]);
    const filesById = makeFilesById([
      { id: "file-B", name: "Assembly.SLDASM", latest_version_id: "ver-new", deleted_at: null },
    ]);
    const result = filterWhereUsedToLatest(refs, versionsById, filesById);
    expect(result).toHaveLength(0);
  });

  it("(c) excludes a soft-deleted parent even when its ref version is current", () => {
    const refs: RefRow[] = [{ parent_version_id: "ver-2" }];
    const versionsById = makeVersionsById([{ id: "ver-2", file_id: "file-C" }]);
    const filesById = makeFilesById([
      { id: "file-C", name: "Deleted.SLDASM", latest_version_id: "ver-2", deleted_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = filterWhereUsedToLatest(refs, versionsById, filesById);
    expect(result).toHaveLength(0);
  });

  it("(d) de-duplicates when the same parent appears via multiple ref rows", () => {
    const refs: RefRow[] = [
      { parent_version_id: "ver-3" },
      { parent_version_id: "ver-3" },
    ];
    const versionsById = makeVersionsById([{ id: "ver-3", file_id: "file-D" }]);
    const filesById = makeFilesById([
      { id: "file-D", name: "TopLevel.SLDASM", latest_version_id: "ver-3", deleted_at: null },
    ]);
    const result = filterWhereUsedToLatest(refs, versionsById, filesById);
    expect(result).toHaveLength(1);
    expect(result[0]!.parentFileId).toBe("file-D");
  });
});
