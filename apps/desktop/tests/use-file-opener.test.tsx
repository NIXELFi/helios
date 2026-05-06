import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useFileOpener } from "../src/lib/use-file-opener";

afterEach(cleanup);

// Mock chain: useFileOpener calls listen() once at mount and invoke()
// (for get_pending_open_files) once at mount, then for each path it calls
// readTextFile().
const eventListeners: Array<(payload: { payload: string[] }) => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: (payload: { payload: string[] }) => void) => {
    eventListeners.push(handler);
    // Return an unlisten function
    return Promise.resolve(() => {});
  }),
}));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => mockInvoke(cmd),
}));

const mockReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (path: string) => mockReadTextFile(path),
}));

const validBundle = (label: string) =>
  JSON.stringify({
    kind: "helios-workspace-bundle",
    version: 1,
    exportedAt: "2026-05-06T00:00:00.000Z",
    exportedFrom: "Helios test",
    workspaces: [{ id: "x", label, color: "#FFC627", tiles: [] }],
  });

function Harness({ onPending }: { onPending: (s: any) => void }) {
  useFileOpener({ onPending });
  return null;
}

describe("useFileOpener", () => {
  beforeEach(() => {
    eventListeners.length = 0;
    mockInvoke.mockReset();
    mockReadTextFile.mockReset();
    // Default: no pending files at mount
    mockInvoke.mockResolvedValue([]);
  });

  it("on event with two valid paths, fires onPending with PerFileResult[]", async () => {
    mockReadTextFile
      .mockResolvedValueOnce(validBundle("A"))
      .mockResolvedValueOnce(validBundle("B"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/path/a.helios", "/path/b.helios"] });

    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg.length).toBe(2);
    expect(arg[0]).toMatchObject({ kind: "valid", filename: "a.helios" });
    expect(arg[1]).toMatchObject({ kind: "valid", filename: "b.helios" });
  });

  it("one valid + one invalid yields kind: 'valid' and kind: 'invalid'", async () => {
    mockReadTextFile
      .mockResolvedValueOnce(validBundle("A"))
      .mockResolvedValueOnce("not json {");
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/p/a.helios", "/p/b.helios"] });
    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0].kind).toBe("valid");
    expect(arg[1].kind).toBe("invalid");
  });

  it("readTextFile rejection becomes kind: 'invalid' with 'Could not read file' reason", async () => {
    mockReadTextFile.mockRejectedValue(new Error("permission denied"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/p/a.helios"] });
    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0]).toMatchObject({ kind: "invalid", filename: "a.helios" });
    expect(arg[0].reason).toMatch(/could not read file/i);
  });

  it("at mount, drains get_pending_open_files and processes those paths too", async () => {
    mockInvoke.mockResolvedValue(["/initial/a.helios"]);
    mockReadTextFile.mockResolvedValue(validBundle("A"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);

    await waitFor(() => expect(onPending).toHaveBeenCalled());
    expect(mockInvoke).toHaveBeenCalledWith("get_pending_open_files");
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0]).toMatchObject({ kind: "valid", filename: "a.helios" });
  });
});
