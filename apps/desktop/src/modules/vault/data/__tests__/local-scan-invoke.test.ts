/**
 * useLocalFolderScan — native scan path (v5.7.1).
 *
 * The walk moved into Rust (`scan_vault_folder`): one IPC round-trip instead
 * of a `stat` per file, with a hash cache that survives relaunch. The JS walk
 * stays as the fallback for any environment without the native command —
 * which is every vitest run, since jsdom has no Tauri runtime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const readDir = vi.fn();
const readFile = vi.fn();
const stat = vi.fn();
const watchImmediate = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...args: unknown[]) => readDir(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  stat: (...args: unknown[]) => stat(...args),
  watchImmediate: (...args: unknown[]) => watchImmediate(...args),
}));

import { useLocalFolderScan } from "../useLocalFolderScan";

const ROOT = "C:/Users/x/Helios/SDM25";

/** Wire the plugin-fs mocks up as a one-file tree so the JS walk can run. */
function stubJsWalk() {
  stat.mockImplementation(async (path: string) => {
    if (path === ROOT) return { isDirectory: true, size: 0, mtime: new Date(0) };
    return { size: 5, mtime: new Date(1_700_000_000_000), readonly: true };
  });
  readDir.mockResolvedValue([
    { name: "fallback.sldprt", isFile: true, isDirectory: false, isSymlink: false },
  ]);
  readFile.mockResolvedValue(new Uint8Array([104, 101, 108, 108, 111]));
}

beforeEach(() => {
  invoke.mockReset();
  readDir.mockReset();
  readFile.mockReset();
  stat.mockReset();
  watchImmediate.mockReset();
});

describe("useLocalFolderScan native path", () => {
  it("publishes the entries and sidecars the Rust command returned", async () => {
    invoke.mockResolvedValue({
      rootExists: true,
      entries: [
        {
          basename: "frame.sldprt",
          relativePath: "Chassis/frame.sldprt",
          absolutePath: `${ROOT}/Chassis/frame.sldprt`,
          sha256: "abc123",
          sizeBytes: 42,
          readonly: true,
        },
      ],
      openInSw: ["Chassis/upright.sldprt"],
    });

    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(invoke).toHaveBeenCalledWith("scan_vault_folder", { root: ROOT });
    expect(result.current.files).toEqual([
      {
        basename: "frame.sldprt",
        relativePath: "Chassis/frame.sldprt",
        absolutePath: `${ROOT}/Chassis/frame.sldprt`,
        sha256: "abc123",
        sizeBytes: 42,
        readonly: true,
      },
    ]);
    expect(result.current.openInSw.has("Chassis/upright.sldprt")).toBe(true);
    expect(result.current.rootMissing).toBe(false);
    expect(result.current.scanRoot).toBe(ROOT);
    // The whole point: no per-file stat/read IPC from the webview.
    expect(readDir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports a missing root from the command's own flag", async () => {
    invoke.mockResolvedValue({ rootExists: false, entries: [], openInSw: [] });

    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(result.current.files).toEqual([]);
    expect(result.current.rootMissing).toBe(true);
    expect(stat).not.toHaveBeenCalled();
  });

  it("falls back to the JS walk when the command is unavailable", async () => {
    invoke.mockRejectedValue(
      new Error("window.__TAURI_INTERNALS__ is not defined"),
    );
    stubJsWalk();

    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(result.current.files?.map((f) => f.relativePath)).toEqual([
      "fallback.sldprt",
    ]);
    expect(readDir).toHaveBeenCalled();
  });

  it("falls back to the JS walk when invoke resolves nothing (no Tauri host)", async () => {
    // jsdom's stub transport in tests/setup.ts resolves every invoke to null
    // rather than throwing, so a null/shape-less result must fall back too.
    invoke.mockResolvedValue(null);
    stubJsWalk();

    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(result.current.files?.map((f) => f.relativePath)).toEqual([
      "fallback.sldprt",
    ]);
  });
});
