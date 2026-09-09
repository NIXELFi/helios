/**
 * useLocalFolderScan — native scan path (v5.7.1).
 *
 * The walk moved into Rust (`scan_vault_folder`): one IPC round-trip instead
 * of a `stat` per file, with a hash cache that survives relaunch. The JS walk
 * stays as the fallback for any environment without the native command —
 * which is every vitest run, since jsdom has no Tauri runtime.
 *
 * `relativePath` is the key auto-sync's locally-deleted detection and the
 * deleted-file reaper match on, so the first native scan of each root is
 * shadow-checked against a listing produced by the JS recursion. Every test
 * here loads the hook through `freshHook()` so the module-level shadow state
 * (verified roots + the native-disabled latch) starts empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

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

const ROOT = "C:/Users/x/Helios/SDM25";

type Hook = typeof import("../useLocalFolderScan")["useLocalFolderScan"];

/** A hook bound to a fresh module instance, so no session state leaks. */
async function freshHook(): Promise<Hook> {
  vi.resetModules();
  return (await import("../useLocalFolderScan")).useLocalFolderScan;
}

const dir = (name: string) => ({
  name,
  isFile: false,
  isDirectory: true,
  isSymlink: false,
});
const file = (name: string) => ({
  name,
  isFile: true,
  isDirectory: false,
  isSymlink: false,
});

/** Wire the plugin-fs mocks up as a one-file tree so the JS walk can run. */
function stubJsWalk() {
  stat.mockImplementation(async (path: string) => {
    if (path === ROOT) return { isDirectory: true, size: 0, mtime: new Date(0) };
    return { size: 5, mtime: new Date(1_700_000_000_000), readonly: true };
  });
  readDir.mockResolvedValue([file("fallback.sldprt")]);
  readFile.mockResolvedValue(new Uint8Array([104, 101, 108, 108, 111]));
}

beforeEach(() => {
  invoke.mockReset();
  readDir.mockReset();
  readFile.mockReset();
  stat.mockReset();
  watchImmediate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    // Same tree as the command reported, so the shadow check agrees.
    readDir.mockImplementation(async (path: string) =>
      path === ROOT
        ? [dir("Chassis")]
        : [file("frame.sldprt"), file("~$upright.sldprt")],
    );

    const useLocalFolderScan = await freshHook();
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
    // The whole point: no file bytes read through the webview.
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("reports a missing root from the command's own flag", async () => {
    invoke.mockResolvedValue({ rootExists: false, entries: [], openInSw: [] });

    const useLocalFolderScan = await freshHook();
    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(result.current.files).toEqual([]);
    expect(result.current.rootMissing).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    // Nothing to cross-check against when the root isn't there.
    expect(readDir).not.toHaveBeenCalled();
  });

  it("falls back to the JS walk when the command is unavailable", async () => {
    invoke.mockRejectedValue(
      new Error("window.__TAURI_INTERNALS__ is not defined"),
    );
    stubJsWalk();

    const useLocalFolderScan = await freshHook();
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

    const useLocalFolderScan = await freshHook();
    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    expect(result.current.files?.map((f) => f.relativePath)).toEqual([
      "fallback.sldprt",
    ]);
  });
});

describe("useLocalFolderScan shadow check", () => {
  it("cross-checks the first native scan of a root and never again", async () => {
    invoke.mockResolvedValue({
      rootExists: true,
      entries: [
        {
          basename: "frame.sldprt",
          relativePath: "Chassis/frame.sldprt",
          absolutePath: `${ROOT}/Chassis/frame.sldprt`,
          sha256: "abc123",
          sizeBytes: 42,
          readonly: false,
        },
      ],
      openInSw: ["Chassis/upright.sldprt"],
    });
    readDir.mockImplementation(async (path: string) =>
      path === ROOT
        ? [dir("Chassis")]
        : [file("frame.sldprt"), file("~$upright.sldprt")],
    );

    const useLocalFolderScan = await freshHook();
    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    // Root + Chassis: the shadow listing, once.
    expect(readDir).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    // The second scan is native-only — no shadow listing.
    expect(readDir).toHaveBeenCalledTimes(2);
    expect(result.current.files?.map((f) => f.relativePath)).toEqual([
      "Chassis/frame.sldprt",
    ]);
  });

  it("publishes the JS walk and stops using the command when the listings differ", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockResolvedValue({
      rootExists: true,
      entries: [
        {
          basename: "frame.sldprt",
          // A path-format regression: backslashes where the rest of the Vault
          // expects "/". Reading this as truth would look like a mass delete.
          relativePath: "Chassis\\frame.sldprt",
          absolutePath: `${ROOT}\\Chassis\\frame.sldprt`,
          sha256: "abc123",
          sizeBytes: 42,
          readonly: false,
        },
      ],
      openInSw: [],
    });
    readDir.mockImplementation(async (path: string) =>
      path === ROOT ? [dir("Chassis")] : [file("frame.sldprt")],
    );
    stat.mockImplementation(async (path: string) =>
      path === ROOT
        ? { isDirectory: true, size: 0, mtime: new Date(0) }
        : { size: 5, mtime: new Date(1_700_000_000_000), readonly: false },
    );
    readFile.mockResolvedValue(new Uint8Array([104, 101, 108, 108, 111]));

    const useLocalFolderScan = await freshHook();
    const { result } = renderHook(() => useLocalFolderScan(ROOT));
    await waitFor(() => expect(result.current.files).not.toBeNull());

    // The JS walk's result wins — forward slashes, hashed for real.
    expect(result.current.files?.map((f) => f.relativePath)).toEqual([
      "Chassis/frame.sldprt",
    ]);
    expect(readFile).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(ROOT);

    const invokeCalls = invoke.mock.calls.length;
    const readDirCalls = readDir.mock.calls.length;
    await act(async () => {
      result.current.refetch();
    });
    // The rescan runs the JS walk again (its sha cache spares the re-read, so
    // watch readDir rather than readFile).
    await waitFor(() =>
      expect(readDir.mock.calls.length).toBeGreaterThan(readDirCalls),
    );

    // The latch holds for the rest of the session: no second native attempt.
    expect(invoke).toHaveBeenCalledTimes(invokeCalls);
  });
});
