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

const checkInRun = vi.fn();
const checkInErrorRef: { current: Error | null } = { current: null };
const checkoutsRefetch = vi.fn();
const locksRefetch = vi.fn();
const readFile = vi.fn();

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

// ---- Tauri + IO shims ------------------------------------------------------
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: (...a: unknown[]) => readFile(...a) }));
vi.mock("../../data/fs-readonly", () => ({ setReadonly: vi.fn(), flipSwReadonly: vi.fn() }));
vi.mock("../../data/sync-ledger", () => ({ ledgerRecord: vi.fn() }));

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

// ---- Check-in primitive (errorRef is the sync-fresh error channel) ---------
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null, errorRef: checkInErrorRef }),
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

beforeEach(() => {
  checkoutsData = [draftRow()];
  foldersData = [];
  readFile.mockReset();
  checkInRun.mockReset();
  checkoutsRefetch.mockReset();
  locksRefetch.mockReset();
  checkInErrorRef.current = null;
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  checkInRun.mockResolvedValue({ id: "ver1", version_num: 1, sha256: "abc123" });
});
afterEach(cleanup);

describe("WhoHasWhatScreen — check in your own checkouts", () => {
  it("offers a bulk 'Check in all mine' button for the user's active-vault checkouts", () => {
    render(<WhoHasWhatScreen />);
    expect(screen.getByRole("button", { name: /check in all mine \(1\)/i })).toBeTruthy();
  });

  it("bulk: reads the working copy and uploads exactly those bytes", async () => {
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));

    await waitFor(() => expect(readFile).toHaveBeenCalledWith("C:/Vault/SDM27/part.SLDPRT"));
    await waitFor(() => expect(checkInRun).toHaveBeenCalledTimes(1));
    const [fileId, bytes, comment] = checkInRun.mock.calls[0]!;
    expect(fileId).toBe("file1");
    // The CENTRAL integrity claim: the on-disk bytes are what get checked in.
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(bytes as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(comment).toMatch(/checked in/i);
    await waitFor(() => expect(checkoutsRefetch).toHaveBeenCalled());
  });

  it("resolves a subfolder file's path through the folder tree", async () => {
    foldersData = [
      { id: "fld1", vault_id: "v1", parent_id: null, name: "Chassis", created_at: "2026-01-01T00:00:00Z" } as Folder,
    ];
    checkoutsData = [draftRow({ folder_id: "fld1" })];
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("C:/Vault/SDM27/Chassis/part.SLDPRT"));
  });

  it("per-row: a 'Check in' button checks in just that file", async () => {
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^check in$/i }));
    await waitFor(() => expect(checkInRun).toHaveBeenCalledTimes(1));
    expect(checkInRun.mock.calls[0]![0]).toBe("file1");
  });

  it("surfaces the real check-in error (not a generic message)", async () => {
    checkInRun.mockResolvedValue(null);
    checkInErrorRef.current = new Error("editor role required to check in");
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^check in$/i }));
    await waitFor(() => expect(screen.getByText(/editor role required/i)).toBeTruthy());
  });

  it("reports when a file has no local copy to check in", async () => {
    readFile.mockReset();
    readFile.mockRejectedValue(new Error("ENOENT"));
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));
    await waitFor(() => expect(screen.getByText(/no local copy/i)).toBeTruthy());
    expect(checkInRun).not.toHaveBeenCalled();
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
