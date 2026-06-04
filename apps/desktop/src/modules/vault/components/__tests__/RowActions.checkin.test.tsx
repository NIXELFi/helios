import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Tauri plugin shims — capture calls so we can assert which read path runs.
const readFile = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: (...a: unknown[]) => readFile(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: vi.fn(),
}));

// Stub every data hook RowActions pulls in so the component renders without a
// Supabase client / provider. Only CheckInButton's hooks actually run here.
const checkInRun = vi.fn();
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null }),
}));
vi.mock("../../data/useAcquireLock", () => ({ useAcquireLock: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useReleaseLock", () => ({ useReleaseLock: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useDownloadVersion", () => ({ useDownloadVersion: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useRecordRefs", () => ({ useRecordRefs: () => ({ run: vi.fn() }) }));
vi.mock("../../data/useRecordProperties", () => ({ useRecordProperties: () => ({ run: vi.fn() }) }));
vi.mock("../../data/fs-readonly", () => ({ setReadonly: vi.fn() }));

import { CheckInButton } from "../RowActions";

beforeEach(() => {
  readFile.mockReset();
  openDialog.mockReset();
  checkInRun.mockReset();
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  openDialog.mockResolvedValue(null);
  checkInRun.mockResolvedValue({ id: "ver1", version_num: 2 });
});

describe("CheckInButton with no scan-matched local file", () => {
  it("reads the canonical vault working-copy path instead of prompting a file dialog", async () => {
    render(
      <CheckInButton
        fileId="f1"
        localFile={undefined}
        vaultRoot="C:/Vault/SDM26"
        folderId={null}
        fileName="part.SLDPRT"
        folders={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    // It must read the computed working-copy path (vaultRoot + name), NOT make
    // the user hunt for a file that's already on disk.
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("C:/Vault/SDM26/part.SLDPRT"));
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("falls back to the file picker only when the canonical path is unreadable", async () => {
    readFile.mockReset();
    readFile.mockRejectedValueOnce(new Error("ENOENT")); // canonical read fails
    openDialog.mockResolvedValueOnce("C:/elsewhere/part.SLDPRT");
    readFile.mockResolvedValueOnce(new Uint8Array([9])); // picker read succeeds
    render(
      <CheckInButton
        fileId="f1"
        localFile={undefined}
        vaultRoot="C:/Vault/SDM26"
        folderId={null}
        fileName="part.SLDPRT"
        folders={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
  });
});
