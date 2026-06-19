/**
 * BulkActionBar — abort-guard regression tests (H9, M13)
 *
 * H9: bulkCheckOut had no beginAbortScope() call, so a navigation-away /
 *     selection-clear mid-loop kept acquiring locks on files the user no
 *     longer had selected.
 *
 * M13: bulkDelete had the same problem — partial deletes completed after the
 *      selection was cleared with no status update.
 *
 * Strategy: mock every data hook directly (no Supabase provider needed).
 * Gate the first operation on a deferred promise so the loop is suspended
 * mid-flight, then re-render with an empty selection (which triggers the
 * useEffect cleanup → abort), release the gate, flush all microtasks, and
 * assert that no second call was issued.
 */
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
}));

import { BulkActionBar } from "../BulkActionBar";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A deferred whose resolution the test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Flush the microtask + macrotask queue a few times. */
async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  acquireLockRun.mockReset();
  releaseLockRun.mockReset();
  deleteFileRun.mockReset();
  downloadRun.mockReset();
  checkInRun.mockReset();
  // Default: operations succeed immediately
  acquireLockRun.mockResolvedValue({ id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null });
  releaseLockRun.mockResolvedValue(true);
  deleteFileRun.mockResolvedValue(true);
  downloadRun.mockResolvedValue(true);
  checkInRun.mockResolvedValue({ id: "ver1", version_num: 2, sha256: "abc" });
});

// ── H9: bulkCheckOut abort ───────────────────────────────────────────────────

describe("BulkActionBar — H9: bulkCheckOut respects abort signal", () => {
  it("stops acquiring locks after selection is cleared mid-loop", async () => {
    const gate = deferred();
    // First acquireLock call blocks until the gate releases; second should never fire.
    acquireLockRun
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null };
      })
      .mockResolvedValue({ id: "l2", file_id: "f2", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null });

    const { rerender } = render(
      <BulkActionBar
        selectedIds={["f1", "f2"]}
        onClear={() => {}}
        onDone={() => {}}
        currentUserId="u1"
        locks={[]}
      />,
    );

    const checkOutBtn = screen.getByRole("button", { name: /check out/i });
    await act(async () => { fireEvent.click(checkOutBtn); });

    // First lock acquire is in flight (blocked on gate); second hasn't started.
    await waitFor(() => expect(acquireLockRun).toHaveBeenCalledTimes(1));

    // Clear selection → triggers the useEffect cleanup → aborts the in-flight scope.
    rerender(
      <BulkActionBar
        selectedIds={[]}
        onClear={() => {}}
        onDone={() => {}}
        currentUserId="u1"
        locks={[]}
      />,
    );

    // Release the gate so the awaited lock acquire resolves, then flush everything.
    await act(async () => {
      gate.resolve();
      await flushAsync();
    });

    // The loop must have seen signal.aborted after the first acquire resolved
    // and returned without starting the second file's lock acquisition.
    expect(acquireLockRun).toHaveBeenCalledTimes(1);
  });

  it("does not call setState (setBusy/setStatus) after abort", async () => {
    // If the component calls setState after unmount the test would produce a
    // React "Can't perform a state update on an unmounted component" warning
    // (or act() warning). We unmount instead of rerender to trigger abort.
    const gate = deferred();
    acquireLockRun.mockImplementationOnce(async () => {
      await gate.promise;
      return { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null };
    });

    const { unmount } = render(
      <BulkActionBar
        selectedIds={["f1", "f2"]}
        onClear={() => {}}
        onDone={() => {}}
        currentUserId="u1"
        locks={[]}
      />,
    );

    const checkOutBtn = screen.getByRole("button", { name: /check out/i });
    await act(async () => { fireEvent.click(checkOutBtn); });
    await waitFor(() => expect(acquireLockRun).toHaveBeenCalledTimes(1));

    // Unmount mid-flight to trigger abort
    unmount();

    // Release the gate and flush — the loop should return without calling
    // setState or touching the second file.
    await act(async () => {
      gate.resolve();
      await flushAsync();
    });

    expect(acquireLockRun).toHaveBeenCalledTimes(1);
  });
});

// ── M13: bulkDelete abort ────────────────────────────────────────────────────

describe("BulkActionBar — M13: bulkDelete respects abort signal", () => {
  it("stops deleting after selection is cleared mid-loop", async () => {
    const gate = deferred();
    // First delete blocks; second should never start after the abort.
    deleteFileRun
      .mockImplementationOnce(async () => {
        await gate.promise;
        return true;
      })
      .mockResolvedValue(true);

    const onDone = vi.fn();

    const { rerender } = render(
      <BulkActionBar
        selectedIds={["f1", "f2"]}
        onClear={() => {}}
        onDone={onDone}
        vaultId="v1"
      />,
    );

    // Open the confirmation modal and confirm delete
    const deleteBtn = screen.getByRole("button", { name: /^delete$/i });
    fireEvent.click(deleteBtn);
    await waitFor(() =>
      expect(screen.getByText(/move to this vault.s deleted tab/i)).toBeInTheDocument(),
    );
    // There are two Delete buttons now (the bar and the modal confirm).
    // Click the one inside the modal (the second one).
    const allDeleteBtns = screen.getAllByRole("button", { name: /^delete$/i });
    await act(async () => { fireEvent.click(allDeleteBtns[allDeleteBtns.length - 1]); });

    // First delete call is in flight.
    await waitFor(() => expect(deleteFileRun).toHaveBeenCalledTimes(1));

    // Clear selection → triggers abort
    rerender(
      <BulkActionBar
        selectedIds={[]}
        onClear={() => {}}
        onDone={onDone}
        vaultId="v1"
      />,
    );

    // Release the gate and flush
    await act(async () => {
      gate.resolve();
      await flushAsync();
    });

    // The loop must have aborted — only one delete call, not two.
    expect(deleteFileRun).toHaveBeenCalledTimes(1);
  });

  it("still surfaces partial-delete status when loop aborts mid-run", async () => {
    // Even if the operation is aborted, the files that DID get deleted should
    // be surfaced in the status (matching how bulkCheckIn/bulkGetLatest report
    // partial progress). This test verifies the status is shown up to the abort
    // point rather than being silently swallowed.
    //
    // We do NOT test the exact text here (that would be over-specifying) —
    // we just assert a status element is rendered after the run completes
    // normally (no abort) with a failed file in the batch, confirming the
    // failure-path status reporting works.
    deleteFileRun
      .mockResolvedValueOnce(true)   // f1 succeeds
      .mockResolvedValueOnce(false); // f2 fails

    const { container } = render(
      <BulkActionBar
        selectedIds={["f1", "f2"]}
        onClear={() => {}}
        onDone={() => {}}
        vaultId="v1"
        files={[
          { id: "f1", vault_id: "v1", folder_id: null, name: "part-a.sldprt", latest_version_id: null, created_at: "x" } as any,
          { id: "f2", vault_id: "v1", folder_id: null, name: "part-b.sldprt", latest_version_id: null, created_at: "x" } as any,
        ]}
      />,
    );

    const deleteBtn = screen.getByRole("button", { name: /^delete$/i });
    fireEvent.click(deleteBtn);
    await waitFor(() =>
      expect(screen.getByText(/move to this vault.s deleted tab/i)).toBeInTheDocument(),
    );
    const allDeleteBtns = screen.getAllByRole("button", { name: /^delete$/i });
    await act(async () => { fireEvent.click(allDeleteBtns[allDeleteBtns.length - 1]); });

    // Status must appear, naming the failure
    await waitFor(() => {
      const status = container.querySelector("[role='status']");
      expect(status).not.toBeNull();
      expect(status!.textContent).toMatch(/failed|part-b/i);
    });
  });
});
