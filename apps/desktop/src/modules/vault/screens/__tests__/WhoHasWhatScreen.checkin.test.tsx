import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Folder } from "../../data/types";

// ---- Mutable fixtures (set per test before render) -------------------------
interface CheckoutRow {
  lock_id: string;
  file_id: string;
  user_id: string;
  acquired_at: string;
  vault_id: string;
  vault_name: string;
  folder_id: string | null;
  file_name: string | null;
  deleted_at: string | null;
  is_draft: boolean;
}
let checkoutsData: CheckoutRow[] = [];
let foldersData: Folder[] = [];

const checkoutsRefetch = vi.fn();
const locksRefetch = vi.fn();

function draftRow(over: Partial<CheckoutRow> = {}): CheckoutRow {
  return {
    lock_id: "lock1",
    file_id: "file1",
    user_id: "u1",
    acquired_at: "2026-06-29T00:00:00Z",
    vault_id: "v1",
    vault_name: "SDM27",
    folder_id: null,
    file_name: "part.SLDPRT",
    deleted_at: null,
    is_draft: true,
    ...over,
  };
}

// ---- Batch hook + its inputs ----------------------------------------------
// Check-in runs through the shared useVaultBatchOps (its reads, uploads, refs
// recording and saved-again guard are covered by the hook's own tests); here we
// pin what THIS screen hands it and how it shows the outcome.
const batchRun = vi.fn();
let batchBusy = false;
let batchCtx: any = null;
let catalogData: any[] | null = [];
let scanFiles: any[] | null = [];
vi.mock("../../data/useVaultBatchOps", () => ({
  useVaultBatchOps: (ctx: unknown) => {
    batchCtx = ctx;
    return { run: batchRun, stop: vi.fn(), abort: vi.fn(), busy: batchBusy, stopping: false, progress: null };
  },
}));
vi.mock("../../data/vault-files-context", () => ({
  useVaultFiles: () => ({ data: catalogData, loading: false, error: null }),
}));
vi.mock("../../data/useLocalFolderScan", () => ({
  useLocalFolderScan: (root: string | null) => ({ files: scanFiles, scanRoot: root, refetch: vi.fn() }),
}));

// ---- Identity / role -------------------------------------------------------
vi.mock("@helios/auth", () => ({ useUser: () => ({ id: "u1" }) }));
vi.mock("../../data/useIsAdmin", () => ({ useIsAdmin: () => false }));
vi.mock("../../data/useVaultRole", () => ({ useIsVaultAdmin: () => false }));

// ---- Active vault + local root ---------------------------------------------
vi.mock("../../data/useActiveVault", () => ({
  useActiveVault: () => ({ activeVaultId: "v1", vaults: [{ id: "v1", name: "SDM27" }] }),
}));
vi.mock("../../data/useVaultFolder", () => ({
  useVaultFolder: () => ({ path: "C:/Vault/SDM27", root: "C:/Vault", setRoot: vi.fn(), clear: vi.fn() }),
}));
vi.mock("../../data/useCrossVaultFolders", () => ({
  useCrossVaultFolders: () => ({ data: foldersData, error: null }),
}));

vi.mock("../../data/useForceUnlock", () => ({
  useForceUnlock: () => ({ run: vi.fn(), loading: false, error: null }),
}));

// ---- Active-checkouts RPC source -------------------------------------------
vi.mock("../../data/useActiveCheckouts", () => ({
  useActiveCheckouts: () => ({ supported: true, data: checkoutsData, error: null, refetch: checkoutsRefetch }),
}));

// ---- Legacy/fallback sources (unused in RPC mode) --------------------------
vi.mock("../../data/useLocks", () => ({
  useLocks: () => ({ data: [], loading: false, error: null, refetch: locksRefetch }),
}));
vi.mock("../../data/useFilesByIds", () => ({ useFilesByIds: () => ({ data: [], loading: false, error: null }) }));
vi.mock("../../data/useVaultUsers", () => ({ useVaultUsers: () => ({ data: [] }) }));
vi.mock("../../../org/data/useOrgData", () => ({ usePeople: () => ({ data: [] }) }));

import { WhoHasWhatScreen } from "../WhoHasWhatScreen";

function result(over: Record<string, unknown> = {}) {
  return { op: "checkin", total: 1, ok: 1, aborted: false, stopped: false, status: "Checked in 1/1", outcomes: [], failedCount: 0, ...over };
}

beforeEach(() => {
  checkoutsData = [draftRow()];
  foldersData = [];
  batchRun.mockReset();
  batchRun.mockResolvedValue(result());
  batchBusy = false;
  batchCtx = null;
  catalogData = [{ id: "file1", vault_id: "v1", folder_id: null, name: "part.SLDPRT", latest_version_id: null, latest: null }];
  scanFiles = [];
  checkoutsRefetch.mockReset();
  locksRefetch.mockReset();
});
afterEach(cleanup);

describe("WhoHasWhatScreen — check in your own checkouts", () => {
  it("offers a bulk 'Check in all mine' button for the user's active-vault checkouts", () => {
    render(<WhoHasWhatScreen />);
    expect(screen.getByRole("button", { name: /check in all mine \(1\)/i })).toBeTruthy();
  });

  it("bulk: checks in through the batch hook, releasing unchanged checkouts too", async () => {
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));
    await waitFor(() => expect(batchRun).toHaveBeenCalledTimes(1));
    const [op, ids, opts] = batchRun.mock.calls[0]!;
    expect(op).toBe("checkin");
    expect(ids).toEqual(["file1"]);
    expect(opts).toMatchObject({ includeUnchangedMine: true });
    expect(String(opts.comment)).toMatch(/checked in/i);
    await waitFor(() => expect(checkoutsRefetch).toHaveBeenCalled());
  });

  it("hands the hook the vault context it needs (root, folders, catalog, versions, scan)", async () => {
    foldersData = [
      { id: "fld1", vault_id: "v1", parent_id: null, name: "Chassis", created_at: "2026-01-01T00:00:00Z" } as Folder,
    ];
    catalogData = [{
      id: "file1", vault_id: "v1", folder_id: "fld1", name: "part.SLDPRT", latest_version_id: "ver1",
      latest: { id: "ver1", file_id: "file1", version_num: 2, sha256: "abc", size_bytes: 3, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" },
    }];
    checkoutsData = [draftRow({ folder_id: "fld1" })];
    scanFiles = [{ basename: "part.SLDPRT", relativePath: "Chassis/part.SLDPRT", absolutePath: "C:/Vault/SDM27/Chassis/part.SLDPRT", sha256: "abc", sizeBytes: 3 }];
    render(<WhoHasWhatScreen />);
    expect(batchCtx.vaultRoot).toBe("C:/Vault/SDM27");
    expect(batchCtx.vaultId).toBe("v1");
    expect(batchCtx.currentUserId).toBe("u1");
    expect(batchCtx.folders).toEqual(foldersData);
    expect(batchCtx.files).toBe(catalogData);
    expect(batchCtx.localFiles).toBe(scanFiles);
    expect(batchCtx.versionsByFileId.get("file1")?.[0]?.sha256).toBe("abc");
  });

  it("per-row: a 'Check in' button checks in just that file", async () => {
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^check in$/i }));
    await waitFor(() => expect(batchRun).toHaveBeenCalledTimes(1));
    expect(batchRun.mock.calls[0]![1]).toEqual(["file1"]);
    expect(batchRun.mock.calls[0]![2]).toMatchObject({ includeUnchangedMine: true });
  });

  it("shows the hook's outcome summary and the first failure's reason", async () => {
    batchRun.mockResolvedValue(result({
      ok: 0, failedCount: 1, status: "Checked in 0/1 (1 failed)",
      outcomes: [{ id: "file1", name: "part.SLDPRT", kind: "failed", reason: "editor role required to check in" }],
    }));
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^check in$/i }));
    await waitFor(() => expect(screen.getByText(/checked in 0\/1 \(1 failed\)/i)).toBeTruthy());
    expect(screen.getByText(/part\.SLDPRT: editor role required/i)).toBeTruthy();
    // Nothing succeeded, so the lists are not refetched needlessly.
    expect(checkoutsRefetch).not.toHaveBeenCalled();
  });

  it("disables the check-in buttons until the local scan is ready", () => {
    scanFiles = null;
    render(<WhoHasWhatScreen />);
    expect((screen.getByRole("button", { name: /check in all mine/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^check in$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no check-in for the user's checkouts in a NON-active vault", () => {
    checkoutsData = [draftRow({ lock_id: "lock2", file_id: "file2", vault_id: "v2", vault_name: "SDM26", file_name: "other.SLDPRT" })];
    render(<WhoHasWhatScreen />);
    expect(screen.queryByRole("button", { name: /check in all mine/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^check in$/i })).toBeNull();
  });

  it("does not offer check-in for a recycle-bin (soft-deleted) file", () => {
    checkoutsData = [draftRow({ deleted_at: "2026-06-28T00:00:00Z" })];
    render(<WhoHasWhatScreen />);
    expect(screen.queryByRole("button", { name: /check in all mine/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^check in$/i })).toBeNull();
  });
});
