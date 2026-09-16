import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLocalFolderScan, WATCH_DEBOUNCE_MS } from "../../src/modules/vault/data/useLocalFolderScan";

// Regression: the vault-folder watcher must be the Rust-debounced `watch`,
// never `watchImmediate`. With watchImmediate every raw notify event — one
// per 8 KiB write chunk of every file the native downloader streams to disk —
// crossed IPC as its own webview.eval on the Tauri main thread. During a
// 4-worker auto-sync that was thousands of evals per second: the window
// controls (an invoke on the same thread) stopped responding and module
// switching crawled. Debouncing in Rust collapses a file's write burst into
// one event before it ever reaches the bridge.
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(async () => []),
  readFile: vi.fn(),
  stat: vi.fn(async () => ({ isFile: false, isDirectory: true })),
  watch: vi.fn(async () => () => {}),
  watchImmediate: vi.fn(async () => () => {}),
}));

const fs = await import("@tauri-apps/plugin-fs");

describe("useLocalFolderScan filesystem watcher", () => {
  beforeEach(() => {
    vi.mocked(fs.watch).mockClear();
    vi.mocked(fs.watchImmediate).mockClear();
  });

  it("subscribes with the Rust-side debounced watcher, never watchImmediate", async () => {
    renderHook(() => useLocalFolderScan("/root/SDM27", { watchFs: true }));
    await waitFor(() => expect(fs.watch).toHaveBeenCalledTimes(1));
    const [path, , opts] = vi.mocked(fs.watch).mock.calls[0]!;
    expect(path).toBe("/root/SDM27");
    expect(opts).toMatchObject({ recursive: true, delayMs: WATCH_DEBOUNCE_MS });
    expect(WATCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    expect(fs.watchImmediate).not.toHaveBeenCalled();
  });
});
