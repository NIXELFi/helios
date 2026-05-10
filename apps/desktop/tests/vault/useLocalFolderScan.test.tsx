import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLocalFolderScan } from "../../src/modules/vault/data/useLocalFolderScan";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const fs = await import("@tauri-apps/plugin-fs");

describe("useLocalFolderScan", () => {
  beforeEach(() => {
    vi.mocked(fs.readDir).mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.stat).mockReset();
    // Default stat: each call returns a unique mtime so the sha-cache treats
    // every test file as fresh. Tests that exercise the cache can override.
    let counter = 0;
    vi.mocked(fs.stat).mockImplementation(async () => ({
      isFile: true, isDirectory: false, isSymlink: false,
      size: 3,
      mtime: new Date(1_000_000 + ++counter),
      atime: null, birthtime: null, readonly: false, fileAttributes: null,
      dev: null, ino: null, mode: null, nlink: null, uid: null, gid: null, rdev: null,
      blksize: null, blocks: null,
    } as any));
  });

  it("returns null when no path is given", () => {
    const { result } = renderHook(() => useLocalFolderScan(null));
    expect(result.current.files).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("walks a directory tree and hashes each file", async () => {
    vi.mocked(fs.readDir).mockImplementation(async (p: any) => {
      if (p === "/root") return [
        { name: "a.sldprt", isFile: true, isDirectory: false, isSymlink: false },
        { name: "sub", isFile: false, isDirectory: true, isSymlink: false },
      ] as any;
      if (p === "/root/sub") return [
        { name: "b.sldprt", isFile: true, isDirectory: false, isSymlink: false },
      ] as any;
      return [];
    });
    vi.mocked(fs.readFile).mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { result } = renderHook(() => useLocalFolderScan("/root"));
    await waitFor(() => expect(result.current.files).not.toBeNull());
    expect(result.current.files).toHaveLength(2);
    expect(result.current.files![0].basename).toBe("a.sldprt");
    expect(result.current.files![1].relativePath).toBe("sub/b.sldprt");
    // sha256 of [1,2,3] is well-known
    expect(result.current.files![0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips hidden files and unreadable files gracefully", async () => {
    vi.mocked(fs.readDir).mockResolvedValue([
      { name: ".DS_Store", isFile: true, isDirectory: false, isSymlink: false },
      { name: "good.sldprt", isFile: true, isDirectory: false, isSymlink: false },
      { name: "bad.sldprt", isFile: true, isDirectory: false, isSymlink: false },
    ] as any);
    vi.mocked(fs.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith("bad.sldprt")) throw new Error("permission denied");
      return new Uint8Array([1, 2, 3]);
    });

    const { result } = renderHook(() => useLocalFolderScan("/root"));
    await waitFor(() => expect(result.current.files).not.toBeNull());
    const names = result.current.files!.map((f) => f.basename);
    expect(names).toEqual(["good.sldprt"]);
  });
});
