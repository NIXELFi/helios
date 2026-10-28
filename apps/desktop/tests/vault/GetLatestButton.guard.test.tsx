import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GetLatestButton } from "../../src/modules/vault/components/RowActions";

// Get Latest on a row whose local copy has un-checked-in edits used to write
// the vault bytes straight over them. It now asks first.
const dlCalls = vi.hoisted(() => [] as string[]);
vi.mock("../../src/modules/vault/data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({
    run: (_sha: string, dest: string) => { dlCalls.push(dest); return Promise.resolve(true); },
    loading: false,
    error: null,
  }),
}));
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
  flipSwReadonly: vi.fn(),
}));
vi.mock("../../src/modules/vault/data/sync-ledger", () => ({ ledgerRecord: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn().mockResolvedValue(null), open: vi.fn() }));

const base = {
  fileId: "f1",
  fileName: "frame.sldprt",
  folderId: null,
  latestSha: "abc",
  vaultRoot: "C:/Vault",
  folders: [],
};

beforeEach(() => { dlCalls.length = 0; });

describe("GetLatestButton overwrite guard", () => {
  it("downloads straight away when the local copy is clean", async () => {
    render(<GetLatestButton {...base} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /get latest/i })); });
    await waitFor(() => expect(dlCalls).toHaveLength(1));
    expect(screen.queryByText(/overwrite your changes/i)).toBeNull();
  });

  it("asks before overwriting local edits, and Keep my copy downloads nothing", async () => {
    render(<GetLatestButton {...base} localModified />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /get latest/i })); });
    expect(screen.getByText(/overwrite your changes to frame\.sldprt/i)).toBeInTheDocument();
    expect(dlCalls).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /keep my copy/i })); });
    expect(dlCalls).toHaveLength(0);
  });

  it("downloads after the user confirms the discard", async () => {
    render(<GetLatestButton {...base} localModified />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /get latest/i })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /discard my changes/i })); });
    await waitFor(() => expect(dlCalls).toEqual(["C:/Vault/frame.sldprt"]));
  });
});
