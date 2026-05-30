import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
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

  it("does not follow symlinked directories (avoids cycle hangs)", async () => {
    // A symlinked directory that points back up the tree would cause infinite
    // recursion. The walk must skip entries flagged isSymlink, even when they
    // also report isDirectory.
    vi.mocked(fs.readDir).mockImplementation(async (p: any) => {
      if (p === "/root") return [
        { name: "real.sldprt", isFile: true, isDirectory: false, isSymlink: false },
        // A symlink that looks like a directory and loops back to /root.
        { name: "loop", isFile: false, isDirectory: true, isSymlink: true },
      ] as any;
      if (p === "/root/loop") return [
        { name: "loop", isFile: false, isDirectory: true, isSymlink: true },
      ] as any;
      return [];
    });
    vi.mocked(fs.readFile).mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { result } = renderHook(() => useLocalFolderScan("/root"));
    await waitFor(() => expect(result.current.files).not.toBeNull());
    // Only the real file is collected; the symlinked dir was never descended.
    expect(result.current.files!.map((f) => f.basename)).toEqual(["real.sldprt"]);
    // readDir was NOT called on the symlink target.
    const dirCalls = vi.mocked(fs.readDir).mock.calls.map((c) => c[0]);
    expect(dirCalls).not.toContain("/root/loop");
  });

  it("caps recursion depth so a deep / cyclic real-path tree can't stack-overflow", async () => {
    // Every directory contains another non-symlink subdirectory of the same
    // shape — without a depth cap this recurses forever. The scan must
    // terminate (resolve to a non-null result) rather than hang.
    vi.mocked(fs.readDir).mockImplementation(async (_p: any) => [
      { name: "deeper", isFile: false, isDirectory: true, isSymlink: false },
    ] as any);
    vi.mocked(fs.readFile).mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { result } = renderHook(() => useLocalFolderScan("/root"));
    await waitFor(() => expect(result.current.files).not.toBeNull(), { timeout: 4000 });
    // No files (every level is just a directory) but the scan terminated.
    expect(result.current.files).toEqual([]);
    expect(result.current.error).toBeNull();
    // readDir was called a bounded number of times (depth cap), not unbounded.
    expect(vi.mocked(fs.readDir).mock.calls.length).toBeLessThan(100);
  });

  it("does not commit results if paused flips true during the walk", async () => {
    // A scan started before `paused` flipped true must not commit its
    // (mid-download, partial) results via setFiles — otherwise the file table
    // shows churn from half-written files. We hold readFile open, flip paused
    // to true, then release; the commit must be skipped.
    vi.mocked(fs.readDir).mockResolvedValue([
      { name: "a.sldprt", isFile: true, isDirectory: false, isSymlink: false },
    ] as any);
    let releaseRead: (v: Uint8Array) => void = () => {};
    vi.mocked(fs.readFile).mockImplementation(
      () => new Promise<Uint8Array>((resolve) => { releaseRead = resolve; }),
    );

    const { result, rerender } = renderHook(
      ({ paused }) => useLocalFolderScan("/root", { paused }),
      { initialProps: { paused: false } },
    );

    // The scan is in flight, blocked on readFile. Now pause.
    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ paused: true });

    // Release the read so the walk finishes and reaches its commit point.
    await act(async () => {
      releaseRead(new Uint8Array([1, 2, 3]));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Commit was skipped: files stays null (no partial publish while paused).
    expect(result.current.files).toBeNull();
  });
});
