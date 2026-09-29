/**
 * The O(1) lookup indexes behind matchLocal / folderPath. Both used to rebuild
 * (or linearly scan) per call inside per-file loops — O(files x local) per
 * auto-sync pass on a ~13k-file vault. These pin the exact old semantics.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn(),
}));

import { localFileIndex, matchLocal, normalizePathForCompare } from "../local-match";
import { folderPath, folderResolvable } from "../folder-paths";
import { sameLocalFiles, sameStringSet, type LocalFile } from "../useLocalFolderScan";
import type { Folder, VaultFile, Version } from "../types";

function lf(relativePath: string, sha256 = "aa", extra: Partial<LocalFile> = {}): LocalFile {
  return {
    basename: relativePath.split("/").pop()!,
    relativePath,
    absolutePath: `/root/${relativePath}`,
    sha256,
    sizeBytes: 1,
    readonly: true,
    ...extra,
  };
}

function vf(id: string, name: string, folder_id: string | null = null): VaultFile {
  return {
    id,
    vault_id: "v1",
    folder_id,
    name,
    latest_version_id: null,
    created_at: "2026-01-01T00:00:00Z",
  } as VaultFile;
}

function folder(id: string, name: string, parent_id: string | null): Folder {
  return { id, vault_id: "v1", parent_id, name, created_at: "2026-01-01T00:00:00Z" } as Folder;
}

const noVersions = new Map<string, Version[]>();

describe("localFileIndex / matchLocal", () => {
  it("keeps the FIRST local file for a colliding normalized path (old find semantics)", () => {
    const first = lf("Chassis/Frame.SLDPRT", "first");
    const second = lf("chassis/frame.sldprt", "second");
    const locals = [first, second];
    expect(localFileIndex(locals).get("chassis/frame.sldprt")).toBe(first);
    const folders = [folder("c", "Chassis", null)];
    expect(matchLocal(vf("f", "frame.sldprt", "c"), locals, noVersions, folders).local).toBe(first);
  });

  it("matches across NFD/NFC and case like the linear compare did", () => {
    const nfd = "Café/Part.sldprt"; // macOS readDir form
    const locals = [lf(nfd)];
    const folders = [folder("c", "Café", null)]; // DB (NFC) form
    const m = matchLocal(vf("f", "PART.SLDPRT", "c"), locals, noVersions, folders);
    expect(m.local?.relativePath).toBe(nfd);
    expect(m.status).toBe("modified"); // present, no version rows
  });

  it("builds the index once per array and agrees with a linear find", () => {
    const locals = Array.from({ length: 50 }, (_, i) => lf(`d${i % 5}/f${i}.sldprt`));
    const idx = localFileIndex(locals);
    expect(localFileIndex(locals)).toBe(idx); // cached on array identity
    for (const l of locals) {
      const key = normalizePathForCompare(l.relativePath);
      expect(idx.get(key)).toBe(locals.find((x) => normalizePathForCompare(x.relativePath) === key));
    }
    expect(idx.get("nope.sldprt")).toBeUndefined();
  });

  it("rebuilds when the same array is mutated in place", () => {
    const locals = [lf("a.sldprt")];
    expect(localFileIndex(locals).has("b.sldprt")).toBe(false);
    locals.push(lf("b.sldprt"));
    expect(localFileIndex(locals).has("b.sldprt")).toBe(true);
  });

  it("still reports no-folder / vault-only", () => {
    expect(matchLocal(vf("f", "x"), null, noVersions).status).toBe("no-folder");
    expect(matchLocal(vf("f", "x"), [lf("y")], noVersions).status).toBe("vault-only");
  });
});

describe("folderPath index cache", () => {
  const folders = [
    folder("root", "Chassis", null),
    folder("frame", "Front: Frame", "root"),
    folder("orphan", "Lost", "missing-parent"),
  ];

  it("returns the same paths as before, repeatedly", () => {
    for (let i = 0; i < 3; i++) {
      expect(folderPath("frame", folders)).toBe("Chassis/Front_ Frame");
      expect(folderPath("root", folders)).toBe("Chassis");
      expect(folderPath("orphan", folders)).toBe("");
      expect(folderPath("unknown", folders)).toBe("");
      expect(folderResolvable("orphan", folders)).toBe(false);
      expect(folderResolvable("frame", folders)).toBe(true);
    }
  });

  it("a new folders array (refetch) is resolved fresh, not from the old cache", () => {
    const renamed = [folder("root", "Body", null), folder("frame", "Front: Frame", "root")];
    expect(folderPath("frame", renamed)).toBe("Body/Front_ Frame");
    expect(folderPath("frame", folders)).toBe("Chassis/Front_ Frame");
  });

  it("rebuilds when the same array is mutated in place", () => {
    const list = [folder("a", "A", null)];
    expect(folderPath("b", list)).toBe("");
    list.push(folder("b", "B", "a"));
    expect(folderPath("b", list)).toBe("A/B");
  });
});

describe("sameLocalFiles / sameStringSet", () => {
  it("equal when every field matches, in order", () => {
    expect(sameLocalFiles([lf("a"), lf("b")], [lf("a"), lf("b")])).toBe(true);
    expect(sameLocalFiles([], [])).toBe(true);
  });
  it("differs on any field, order, or length", () => {
    expect(sameLocalFiles([lf("a")], [lf("a", "bb")])).toBe(false);
    expect(sameLocalFiles([lf("a")], [lf("a", "aa", { readonly: false })])).toBe(false);
    expect(sameLocalFiles([lf("a")], [lf("a", "aa", { sizeBytes: 2 })])).toBe(false);
    expect(sameLocalFiles([lf("a"), lf("b")], [lf("b"), lf("a")])).toBe(false);
    expect(sameLocalFiles([lf("a")], [lf("a"), lf("b")])).toBe(false);
  });
  it("set compare ignores order", () => {
    expect(sameStringSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameStringSet(new Set(["a"]), new Set(["b"]))).toBe(false);
  });
});
