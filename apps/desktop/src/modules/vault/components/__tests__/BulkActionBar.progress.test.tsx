/**
 * BulkActionBar — live progress bar + Stop.
 *
 * Bulk actions used to show only disabled buttons until the whole batch
 * finished. They now render a determinate progress bar ("Checking out 2 of
 * 4…") with the file in flight and a Stop button that aborts the run.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

// ── Tauri shims ──────────────────────────────────────────────────────────────
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── Spy handles — defined before vi.mock so factories close over them ────────
const acquireLockRun = vi.fn();
const releaseLockRun = vi.fn();
const deleteFileRun = vi.fn();
const downloadRun = vi.fn();
const checkInRun = vi.fn();

vi.mock("../../data/useAcquireLock", () => ({
  useAcquireLock: () => ({ run: acquireLockRun, loading: false, error: null, result: null }),
}));
vi.mock("../../data/useReleaseLock", () => ({
  useReleaseLock: () => ({ run: releaseLockRun, loading: false, error: null }),
}));
vi.mock("../../data/useDeleteFile", () => ({
  useDeleteFile: () => ({ run: deleteFileRun, loading: false, error: null }),
}));
vi.mock("../../data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({ run: downloadRun, loading: false, error: null }),
}));
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null }),
}));
vi.mock("../../data/useVaultRole", () => ({
  useIsVaultAdmin: () => true, // show Delete button
}));
vi.mock("../../data/fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
  flipSwReadonly: vi.fn(),
}));
vi.mock("../../data/sync-ledger", () => ({
  ledgerRecord: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../data/local-match", () => ({
  matchLocal: vi.fn().mockReturnValue({ status: "vault-only", local: null }),
  vaultRelativePath: vi.fn().mockReturnValue("file.sldprt"),
}));
vi.mock("../../data/folder-paths", () => ({
  localDestPath: vi.fn().mockReturnValue("/vault/file.sldprt"),
  localDestPathStrict: vi.fn().mockReturnValue("/vault/file.sldprt"),
}));


import { BulkActionBar } from "../BulkActionBar";
import { matchLocal } from "../../data/local-match";
import { setReadonly } from "../../data/fs-readonly";
import { ledgerRecord } from "../../data/sync-ledger";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const LOCK = { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null };

beforeEach(() => {
  acquireLockRun.mockReset();
  releaseLockRun.mockReset();
  releaseLockRun.mockResolvedValue(true);
  checkInRun.mockReset();
  vi.mocked(setReadonly).mockClear();
  vi.mocked(ledgerRecord).mockClear();
});

describe("BulkActionBar — progress", () => {
  it("shows a progress bar while a bulk check-out runs, then clears it", async () => {
    const gate = deferred();
    acquireLockRun.mockImplementation(async () => { await gate.promise; return LOCK; });
    render(<BulkActionBar selectedIds={["f1", "f2", "f3", "f4"]} onClear={() => {}} onDone={() => {}} currentUserId="u1" locks={[]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out/i })); });
    const bar = await screen.findByRole("progressbar", { name: /checking out/i });
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText(/Checking out 1 of 4/)).toBeInTheDocument();
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Checked out 4/4");
  });

  it("Stop drains in-flight rows before re-enabling the bar, releasing their locks", async () => {
    const gate = deferred();
    acquireLockRun.mockImplementation(async () => { await gate.promise; return LOCK; });
    render(<BulkActionBar selectedIds={["f1", "f2", "f3", "f4"]} onClear={() => {}} onDone={() => {}} currentUserId="u1" locks={[]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out/i })); });
    await screen.findByRole("progressbar");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^stop$/i })); });
    // Still busy while the 3 in-flight acquires finish — no new run can start.
    expect(screen.getByText(/stopping/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check out/i })).toBeDisabled();
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Stopped — checked out 0 of 4");
    // The in-flight acquires saw the abort and gave their locks back; the 4th
    // file was never started.
    expect(releaseLockRun).toHaveBeenCalledTimes(3);
    expect(acquireLockRun).toHaveBeenCalledTimes(3);
  });

  it("a check-in that lands after Stop is still finalized (read-only + ledger)", async () => {
    const gate = deferred();
    vi.mocked(matchLocal).mockReturnValue({ status: "modified", local: { absolutePath: "/v/a.sldprt" } } as any);
    acquireLockRun.mockResolvedValue(LOCK);
    checkInRun.mockImplementation(async () => { await gate.promise; return { id: "ver2", version_num: 2, sha256: "abc" }; });
    const files = [{ id: "f1", vault_id: "v", folder_id: null, name: "a.sldprt", latest_version_id: "x", created_at: "x" }];
    render(<BulkActionBar selectedIds={["f1"]} onClear={() => {}} onDone={() => {}} files={files as any} localFiles={[]} vaultId="v" currentUserId="u1" locks={[]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check in changes/i })); });
    await waitFor(() => expect(checkInRun).toHaveBeenCalled());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^stop$/i })); });
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(vi.mocked(setReadonly)).toHaveBeenCalledWith("/v/a.sldprt", true);
    expect(vi.mocked(ledgerRecord)).toHaveBeenCalled();
    // The lock went away server-side with the check-in — never released again.
    expect(releaseLockRun).not.toHaveBeenCalled();
    vi.mocked(matchLocal).mockReturnValue({ status: "vault-only", local: null } as any);
  });
});

describe("BulkActionBar — bulk Get Latest keeps local edits", () => {
  it("skips a writable modified copy and downloads a read-only stale one", async () => {
    downloadRun.mockReset();
    downloadRun.mockResolvedValue(true);
    vi.mocked(matchLocal).mockImplementation(((f: any) =>
      f.id === "edited"
        ? { status: "modified", local: { absolutePath: "/v/e.sldprt", readonly: false } }
        : { status: "modified", local: { absolutePath: "/v/s.sldprt", readonly: true } }) as any);
    const files = ["edited", "stale"].map((id) => ({ id, vault_id: "v", folder_id: null, name: id + ".sldprt", latest_version_id: "x", created_at: "x" }));
    const versions = new Map(files.map((f) => [f.id, [{ id: "v-" + f.id, file_id: f.id, version_num: 2, sha256: "sha-" + f.id }]]));
    render(<BulkActionBar selectedIds={["edited", "stale"]} onClear={() => {}} onDone={() => {}} files={files as any} localFiles={[]} versionsByFileId={versions as any} vaultRoot="/v" folders={[]} currentUserId="u1" locks={[]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /get latest/i })); });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Downloaded 1/2 (1 kept — local changes)"));
    expect(downloadRun).toHaveBeenCalledTimes(1);
    expect(downloadRun.mock.calls[0]?.[0]).toBe("sha-stale");
    vi.mocked(matchLocal).mockReset();
    vi.mocked(matchLocal).mockReturnValue({ status: "vault-only", local: null } as any);
  });
});
