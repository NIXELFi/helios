/**
 * BulkActionBar — bulk "Check In Changes" must never strand a lock (audit 0731)
 *
 * bulkCheckInChanges acquires the lock, then reads the local file. When
 * readFile throws — the everyday case, because the part is open in SOLIDWORKS
 * holding an exclusive handle — the row was counted as failed but the lock was
 * NEVER released. The user silently ended up with files checked out to them
 * that nothing in the UI could clear (only an admin force-unlock). The same
 * hole existed on the abort path: the abort scope fires on ANY selection
 * change, so clicking away between acquire and use stranded the lock too.
 *
 * bulkCheckOut already compensates on its failure paths; these tests pin the
 * mirrored behaviour for check-in. Mocking strategy matches
 * BulkActionBar.abort.test.tsx (every data hook stubbed, no Supabase provider).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const readFileMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const acquireLockRun = vi.fn();
const releaseLockRun = vi.fn();
const checkInRun = vi.fn();

vi.mock("../../data/useAcquireLock", () => ({
  useAcquireLock: () => ({ run: acquireLockRun, loading: false, error: null, result: null }),
}));
vi.mock("../../data/useReleaseLock", () => ({
  useReleaseLock: () => ({ run: releaseLockRun, loading: false, error: null }),
}));
vi.mock("../../data/useDeleteFile", () => ({
  useDeleteFile: () => ({ run: vi.fn(), loading: false, error: null }),
}));
vi.mock("../../data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({ run: vi.fn().mockResolvedValue(true), loading: false, error: null }),
}));
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null }),
}));
vi.mock("../../data/useVaultRole", () => ({ useIsVaultAdmin: () => false }));
vi.mock("../../data/fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
  flipSwReadonly: vi.fn(),
}));
vi.mock("../../data/sync-ledger", () => ({
  ledgerRecord: vi.fn().mockResolvedValue(undefined),
}));
// Every selected file reads as locally-modified so the Check In Changes button
// renders and every row is eligible.
vi.mock("../../data/local-match", () => ({
  matchLocal: vi.fn().mockReturnValue({
    status: "modified",
    local: { absolutePath: "/vault/file.sldprt", relativePath: "file.sldprt" },
  }),
  vaultRelativePath: vi.fn().mockReturnValue("file.sldprt"),
}));
vi.mock("../../data/folder-paths", () => ({
  localDestPath: vi.fn().mockReturnValue("/vault/file.sldprt"),
  localDestPathStrict: vi.fn().mockReturnValue("/vault/file.sldprt"),
}));

import { BulkActionBar } from "../BulkActionBar";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const LOCK = {
  id: "l1", file_id: "f1", user_id: "u1",
  acquired_at: "x", released_at: null, force_released_by: null,
};

const FILES = [
  { id: "f1", vault_id: "v1", folder_id: null, name: "part-a.sldprt", latest_version_id: null, created_at: "x" },
  { id: "f2", vault_id: "v1", folder_id: null, name: "part-b.sldprt", latest_version_id: null, created_at: "x" },
] as any[];

function renderBar(props: Record<string, unknown> = {}) {
  return render(
    <BulkActionBar
      selectedIds={["f1"]}
      onClear={() => {}}
      onDone={() => {}}
      currentUserId="u1"
      locks={[]}
      files={FILES}
      localFiles={[]}
      {...props}
    />,
  );
}

async function clickCheckIn() {
  const btn = await screen.findByRole("button", { name: /check in changes/i });
  await act(async () => { fireEvent.click(btn); await flushAsync(); });
}

beforeEach(() => {
  readFileMock.mockReset();
  acquireLockRun.mockReset();
  releaseLockRun.mockReset();
  checkInRun.mockReset();
  readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
  acquireLockRun.mockResolvedValue(LOCK);
  releaseLockRun.mockResolvedValue(true);
  checkInRun.mockResolvedValue({ id: "ver1", version_num: 2, sha256: "abc" });
});

describe("BulkActionBar — bulk check-in lock compensation", () => {
  it("releases the lock it just acquired when readFile throws (file open in SOLIDWORKS)", async () => {
    readFileMock.mockRejectedValue(new Error("The process cannot access the file"));

    renderBar();
    await clickCheckIn();

    expect(acquireLockRun).toHaveBeenCalledWith("f1");
    await waitFor(() => expect(releaseLockRun).toHaveBeenCalledWith("f1"));
  });

  it("releases the lock when the check-in RPC itself fails", async () => {
    checkInRun.mockResolvedValue(null);

    renderBar();
    await clickCheckIn();

    await waitFor(() => expect(releaseLockRun).toHaveBeenCalledWith("f1"));
  });

  it("does NOT release on success — pdm_check_in already released it server-side", async () => {
    renderBar();
    await clickCheckIn();

    await waitFor(() => expect(checkInRun).toHaveBeenCalledTimes(1));
    expect(releaseLockRun).not.toHaveBeenCalled();
  });

  it("does not release a lock it did not acquire (already held by this user)", async () => {
    // The row is already checked out to us, so bulk check-in skips the acquire.
    // A readFile failure must NOT release a lock the user took deliberately.
    readFileMock.mockRejectedValue(new Error("locked by SOLIDWORKS"));

    renderBar({ locks: [{ ...LOCK, file_id: "f1" }] });
    await clickCheckIn();

    expect(acquireLockRun).not.toHaveBeenCalled();
    expect(releaseLockRun).not.toHaveBeenCalled();
  });

  it("releases the lock when the run is aborted between acquire and use", async () => {
    // The abort scope fires on any selection change, so a user clicking away
    // mid-run used to strand the just-acquired lock with no way back.
    const gate = deferred();
    acquireLockRun.mockImplementationOnce(async () => {
      await gate.promise;
      return LOCK;
    });

    const { rerender } = renderBar();
    const btn = await screen.findByRole("button", { name: /check in changes/i });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(acquireLockRun).toHaveBeenCalledTimes(1));

    // Selection change → useEffect cleanup → abort.
    await act(async () => {
      rerender(
        <BulkActionBar
          selectedIds={["f2"]}
          onClear={() => {}}
          onDone={() => {}}
          currentUserId="u1"
          locks={[]}
          files={FILES}
          localFiles={[]}
        />,
      );
      await flushAsync(5);
    });

    await act(async () => { gate.resolve(); await flushAsync(); });

    // Bailed out (no check-in attempted) but gave the lock back.
    expect(checkInRun).not.toHaveBeenCalled();
    await waitFor(() => expect(releaseLockRun).toHaveBeenCalledWith("f1"));
  });
});
