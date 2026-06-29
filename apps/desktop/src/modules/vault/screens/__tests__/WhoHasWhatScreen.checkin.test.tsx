import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Tauri + IO shims — capture the local read so we can assert the working-copy
// path the bulk check-in computes.
const readFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: (...a: unknown[]) => readFile(...a) }));
vi.mock("../../data/fs-readonly", () => ({ setReadonly: vi.fn(), flipSwReadonly: vi.fn() }));
vi.mock("../../data/sync-ledger", () => ({ ledgerRecord: vi.fn() }));

// Identity / role hooks.
vi.mock("@helios/auth", () => ({ useUser: () => ({ id: "u1" }) }));
vi.mock("../../data/useIsAdmin", () => ({ useIsAdmin: () => false }));
vi.mock("../../data/useVaultRole", () => ({ useIsVaultAdmin: () => false }));

// Active vault + its local root.
vi.mock("../../data/useActiveVault", () => ({
  useActiveVault: () => ({ activeVaultId: "v1", vaults: [{ id: "v1", name: "SDM27" }] }),
}));
vi.mock("../../data/useVaultFolder", () => ({
  useVaultFolder: () => ({ path: "C:/Vault/SDM27", root: "C:/Vault", setRoot: vi.fn(), clear: vi.fn() }),
}));
vi.mock("../../data/useCrossVaultFolders", () => ({
  useCrossVaultFolders: () => ({ data: [], error: null }),
}));

// The check-in primitive — captured so we can assert it's called per file.
const checkInRun = vi.fn();
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null }),
}));
const forceUnlockRun = vi.fn();
vi.mock("../../data/useForceUnlock", () => ({
  useForceUnlock: () => ({ run: forceUnlockRun, loading: false, error: null }),
}));

// Active-checkouts RPC source: one draft owned by the current user in the active
// vault — exactly the row "Check in all mine" should act on.
const checkoutsRefetch = vi.fn();
vi.mock("../../data/useActiveCheckouts", () => ({
  useActiveCheckouts: () => ({
    supported: true,
    data: [
      {
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
      },
    ],
    error: null,
    refetch: checkoutsRefetch,
  }),
}));

// Legacy/fallback sources — unused in RPC mode but still called by the screen.
const locksRefetch = vi.fn();
vi.mock("../../data/useLocks", () => ({
  useLocks: () => ({ data: [], loading: false, error: null, refetch: locksRefetch }),
}));
vi.mock("../../data/useFilesByIds", () => ({ useFilesByIds: () => ({ data: [], loading: false, error: null }) }));
vi.mock("../../data/useVaultUsers", () => ({ useVaultUsers: () => ({ data: [] }) }));
vi.mock("../../../org/data/useOrgData", () => ({ usePeople: () => ({ data: [] }) }));

import { WhoHasWhatScreen } from "../WhoHasWhatScreen";

beforeEach(() => {
  readFile.mockReset();
  checkInRun.mockReset();
  checkoutsRefetch.mockReset();
  locksRefetch.mockReset();
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  checkInRun.mockResolvedValue({ id: "ver1", version_num: 1, sha256: "abc123" });
});

describe("WhoHasWhatScreen — check in your own checkouts", () => {
  it("offers a bulk 'Check in all mine' button for the user's active-vault checkouts", () => {
    render(<WhoHasWhatScreen />);
    expect(screen.getByRole("button", { name: /check in all mine \(1\)/i })).toBeTruthy();
  });

  it("reads each file's local working copy and checks it in", async () => {
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));

    // Reads the computed working-copy path (root + name, no folder prefix here).
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("C:/Vault/SDM27/part.SLDPRT"));
    // Calls pdm check-in for the file with a comment (bytes are an ArrayBuffer).
    await waitFor(() => expect(checkInRun).toHaveBeenCalledTimes(1));
    expect(checkInRun.mock.calls[0]![0]).toBe("file1");
    expect(checkInRun.mock.calls[0]![2]).toMatch(/checked in/i);
    // Refreshes the list afterward so the now-released lock drops off.
    await waitFor(() => expect(checkoutsRefetch).toHaveBeenCalled());
  });

  it("reports when a file has no local copy to check in", async () => {
    readFile.mockReset();
    readFile.mockRejectedValue(new Error("ENOENT"));
    render(<WhoHasWhatScreen />);
    fireEvent.click(screen.getByRole("button", { name: /check in all mine/i }));
    await waitFor(() => expect(screen.getByText(/no local copy/i)).toBeTruthy());
    expect(checkInRun).not.toHaveBeenCalled();
  });
});
