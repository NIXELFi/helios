/**
 * FolderBatchDialog: folder-level check-out / check-in with a pre-flight
 * prompt that names what's already checked out (and by whom) and proceeds
 * with the rest.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

const statMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  stat: (...a: unknown[]) => statMock(...a),
}));

const acquireLockRun = vi.fn();
const releaseLockRun = vi.fn();
const downloadRun = vi.fn();
const checkInRun = vi.fn();
const recordRefsRun = vi.fn();
const recordPropsRun = vi.fn();
const checkInErrorRef: { current: Error | null } = { current: null };

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
  useDownloadVersion: () => ({ run: downloadRun, loading: false, error: null }),
}));
vi.mock("../../data/useCheckIn", () => ({
  useCheckIn: () => ({ run: checkInRun, loading: false, error: null, result: null, errorRef: checkInErrorRef }),
}));
vi.mock("../../data/useRecordRefs", () => ({ useRecordRefs: () => ({ run: recordRefsRun }) }));
vi.mock("../../data/useRecordProperties", () => ({ useRecordProperties: () => ({ run: recordPropsRun }) }));
vi.mock("../../data/fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
  flipSwReadonly: vi.fn(),
}));
const ledgerEntries: Record<string, { sha256: string }> = {};
vi.mock("../../data/sync-ledger", () => ({
  ledgerRecord: vi.fn().mockResolvedValue(undefined),
  loadLedger: vi.fn(async () => ({ entries: { ...ledgerEntries } })),
}));

import { FolderBatchDialog } from "../FolderBatchDialog";
import { setReadonly, flipSwReadonly } from "../../data/fs-readonly";
import type { BatchCtx } from "../../data/useVaultBatchOps";
import type { Lock, Version } from "../../data/types";

const ME = "me";
const ALICE = "alice";

// Brakes/
//   caliper.sldprt
//   Rotors/
//     front.sldprt
//     rear.sldprt
//     hub.sldprt
const folders = [
  { id: "fB", vault_id: "v", parent_id: null, name: "Brakes", created_at: "x" },
  { id: "fR", vault_id: "v", parent_id: "fB", name: "Rotors", created_at: "x" },
] as any[];
const files = [
  { id: "caliper", vault_id: "v", folder_id: "fB", name: "caliper.sldprt", latest_version_id: "v-caliper", created_at: "x" },
  { id: "front", vault_id: "v", folder_id: "fR", name: "front.sldprt", latest_version_id: "v-front", created_at: "x" },
  { id: "rear", vault_id: "v", folder_id: "fR", name: "rear.sldprt", latest_version_id: "v-rear", created_at: "x" },
  { id: "hub", vault_id: "v", folder_id: "fR", name: "hub.sldprt", latest_version_id: "v-hub", created_at: "x" },
] as any[];

function version(fileId: string, sha: string): Version {
  return {
    id: `v-${fileId}`, file_id: fileId, version_num: 1, sha256: sha, size_bytes: 1, author_id: ME,
    comment: null, parent_version_id: null, revision: null, properties: null, created_at: "x",
  } as Version;
}
function lock(fileId: string, user: string): Lock {
  return { id: `l-${fileId}`, file_id: fileId, user_id: user, acquired_at: new Date().toISOString(), released_at: null, force_released_by: null };
}
function local(rel: string, sha: string, readonly: boolean) {
  const name = rel.split("/").pop()!;
  return { basename: name, relativePath: rel, absolutePath: `/vault/${rel}`, sha256: sha, sizeBytes: 1, readonly };
}

function baseCtx(over: Partial<BatchCtx> = {}): BatchCtx {
  return {
    files,
    localFiles: [],
    versionsByFileId: new Map(files.map((f) => [f.id, [version(f.id, `sha-${f.id}`)]])),
    vaultRoot: "/vault",
    folders,
    vaultId: "v",
    locks: [],
    currentUserId: ME,
    holderLabelById: new Map([[ALICE, "Alice Smith"]]),
    ...over,
  };
}

function renderDialog(op: "checkout" | "checkin", ctx: BatchCtx, onDone = vi.fn()) {
  return render(
    <FolderBatchDialog
      op={op}
      scope={{ kind: "folder", name: "Brakes", folderId: "fB" }}
      scopeFiles={files}
      ctx={ctx}
      onClose={() => {}}
      onDone={onDone}
    />,
  );
}

beforeEach(() => {
  acquireLockRun.mockReset().mockResolvedValue({ id: "l" });
  releaseLockRun.mockReset().mockResolvedValue(true);
  downloadRun.mockReset().mockResolvedValue(true);
  checkInRun.mockReset();
  recordRefsRun.mockReset().mockResolvedValue(undefined);
  recordPropsRun.mockReset().mockResolvedValue(null);
  statMock.mockReset().mockResolvedValue({ mtime: new Date(1000) });
  checkInErrorRef.current = null;
  for (const k of Object.keys(ledgerEntries)) delete ledgerEntries[k];
  vi.mocked(setReadonly).mockClear();
});

describe("FolderBatchDialog: guards", () => {
  it("never releases a checkout it didn't take when Stop lands on a failed acquire", async () => {
    let finish!: () => void;
    acquireLockRun.mockImplementation(() => new Promise((r) => { finish = () => r(null); }));
    renderDialog("checkout", baseCtx({ files: [files[0]], versionsByFileId: new Map([["caliper", [version("caliper", "sha-caliper")]]]) }));
    await act(async () => {}); // ledger load
    await screen.findByRole("button", { name: /check out \d+ file/i });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out \d+ file/i })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^stop$/i })); });
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByText(/stopped/i)).toBeInTheDocument());
    expect(releaseLockRun).not.toHaveBeenCalled();
  });

  it("holds the run until the lock list has loaded", async () => {
    render(
      <FolderBatchDialog
        op="checkout"
        scope={{ kind: "folder", name: "Brakes", folderId: "fB" }}
        scopeFiles={files}
        ctx={baseCtx()}
        locksReady={false}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText(/loading who has what/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check out 4 files/i })).toBeDisabled();
  });

  it("skips my checkout when this machine only has an older untouched copy", async () => {
    ledgerEntries["brakes/caliper.sldprt"] = { sha256: "old" };
    renderDialog("checkin", baseCtx({
      locks: [lock("caliper", ME)],
      localFiles: [local("Brakes/caliper.sldprt", "old", false)],
    }));
    await act(async () => {}); // ledger load
    const stale = (await screen.findByText(/your copy is an older version \(1\)/i)).closest("section")!;
    expect(within(stale).getByText("caliper.sldprt")).toBeInTheDocument();
    expect(screen.getByText(/nothing here to check in/i)).toBeInTheDocument();
  });
});

describe("FolderBatchDialog: check out", () => {
  it("lists what's already checked out (and by whom), then checks out only the rest", async () => {
    const onDone = vi.fn();
    renderDialog("checkout", baseCtx({ locks: [lock("front", ALICE), lock("rear", ME)] }), onDone);
    await act(async () => {}); // ledger load

    expect(screen.getByTestId("folder-batch-eligible")).toHaveTextContent("2 files will be checked out to you.");
    const others = screen.getByText(/checked out by someone else \(1\)/i).closest("section")!;
    expect(within(others).getByText("Rotors/front.sldprt")).toBeInTheDocument();
    expect(within(others).getByText(/Alice Smith/)).toBeInTheDocument();
    const mine = screen.getByText(/already checked out to you \(1\)/i).closest("section")!;
    expect(within(mine).getByText("Rotors/rear.sldprt")).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out 2 files/i })); });
    await waitFor(() => expect(screen.getByText(/checked out 2 of 2 files/i)).toBeInTheDocument());

    expect(acquireLockRun.mock.calls.map((c) => c[0]).sort()).toEqual(["caliper", "hub"]);
    // No local copies: both were downloaded, then made writable.
    expect(downloadRun).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setReadonly)).toHaveBeenCalledWith("/vault/Brakes/caliper.sldprt", false);
    expect(onDone).toHaveBeenCalledWith(expect.arrayContaining(["caliper", "hub"]));
  });

  it("honours a lock taken after the dialog opened and names it in the results", async () => {
    const { rerender } = renderDialog("checkout", baseCtx());
    await act(async () => {}); // ledger load
    expect(screen.getByTestId("folder-batch-eligible")).toHaveTextContent("4 files");
    // Alice grabs hub while the plan is on screen: the plan updates live.
    rerender(
      <FolderBatchDialog
        op="checkout"
        scope={{ kind: "folder", name: "Brakes", folderId: "fB" }}
        scopeFiles={files}
        ctx={baseCtx({ locks: [lock("hub", ALICE)] })}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
    expect(screen.getByTestId("folder-batch-eligible")).toHaveTextContent("3 files");
  });

  it("rolls back and explains a row whose download failed", async () => {
    downloadRun.mockImplementation(async (sha: string) => sha !== "sha-front");
    renderDialog("checkout", baseCtx());
    await act(async () => {}); // ledger load
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out 4 files/i })); });
    await waitFor(() => expect(screen.getByText(/checked out 3 of 4 files/i)).toBeInTheDocument());
    const failed = screen.getByText(/failed \(1\)/i).closest("section")!;
    expect(within(failed).getByText("Rotors/front.sldprt")).toBeInTheDocument();
    expect(within(failed).getByText(/couldn't download the latest version/i)).toBeInTheDocument();
    expect(releaseLockRun).toHaveBeenCalledWith("front");
  });

  it("only flips the SOLIDWORKS session for files the scan saw open", async () => {
    vi.mocked(flipSwReadonly).mockClear();
    renderDialog("checkout", baseCtx({ openInSw: new Set(["Brakes/Rotors/hub.sldprt"]) }));
    await act(async () => {}); // ledger load
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check out 4 files/i })); });
    await waitFor(() => expect(screen.getByText(/checked out 4 of 4 files/i)).toBeInTheDocument());
    expect(vi.mocked(flipSwReadonly).mock.calls).toEqual([["/vault/Brakes/Rotors/hub.sldprt", false]]);
  });

  it("reports the check-in failure reason for its own row", async () => {
    checkInRun.mockImplementation(async (id: string, _b: unknown, _c: unknown, onError?: (e: Error) => void) => {
      if (id === "caliper") { onError?.(new Error("upload: quota exceeded")); return null; }
      return { id: `v-${id}`, file_id: id, sha256: "x", version_num: 1 };
    });
    renderDialog("checkin", baseCtx({
      locks: [lock("caliper", ME)],
      localFiles: [local("Brakes/caliper.sldprt", "edited", false)],
    }));
    await act(async () => {}); // ledger load
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check in 1 file/i })); });
    await waitFor(() => expect(screen.getByText(/upload: quota exceeded/)).toBeInTheDocument());
  });

  it("keeps writable local edits out of the batch", async () => {
    renderDialog("checkout", baseCtx({ localFiles: [local("Brakes/caliper.sldprt", "edited", false)] }));
    await act(async () => {}); // ledger load
    expect(screen.getByTestId("folder-batch-eligible")).toHaveTextContent("3 files");
    const kept = screen.getByText(/local changes not in the vault \(1\)/i).closest("section")!;
    expect(within(kept).getByText("caliper.sldprt")).toBeInTheDocument();
  });

  it("waits for the local scan before running", async () => {
    renderDialog("checkout", baseCtx({ localFiles: null }));
    await act(async () => {}); // ledger load
    expect(screen.getByRole("button", { name: /check out 4 files/i })).toBeDisabled();
    expect(screen.getByText(/still scanning/i)).toBeInTheDocument();
  });
});

describe("FolderBatchDialog: check in", () => {
  it("checks in changed files, releases unchanged checkouts, and lists blockers", async () => {
    checkInRun.mockImplementation(async (id: string) => ({
      id: id === "caliper" ? "v-caliper-2" : `v-${id}`, file_id: id, sha256: "x", version_num: 2,
    }));
    renderDialog("checkin", baseCtx({
      locks: [lock("caliper", ME), lock("front", ME), lock("rear", ALICE)],
      localFiles: [
        local("Brakes/caliper.sldprt", "edited", false), // mine, changed
        local("Brakes/Rotors/front.sldprt", "sha-front", false), // mine, unchanged
        local("Brakes/Rotors/rear.sldprt", "edited", false), // Alice holds it, I edited
        local("Brakes/Rotors/hub.sldprt", "older", true), // stale read-only copy: not an edit
      ],
    }));
    await act(async () => {}); // ledger load

    expect(screen.getByTestId("folder-batch-eligible")).toHaveTextContent(
      "2 files will be checked in (1 changed, 1 unchanged: those just release your checkout).",
    );
    const blocked = screen.getByText(/changed locally but checked out by someone else \(1\)/i).closest("section")!;
    expect(within(blocked).getByText("Rotors/rear.sldprt")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/what changed/i), { target: { value: "rotor rev B" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check in 2 files/i })); });
    await waitFor(() => expect(screen.getByText(/checked in 2 of 2 files/i)).toBeInTheDocument());

    expect(checkInRun.mock.calls.map((c) => [c[0], c[2]]).sort()).toEqual([
      ["caliper", "rotor rev B"],
      ["front", "rotor rev B"],
    ]);
    // Already held: no new lock taken. Only the changed file gets refs/data card.
    expect(acquireLockRun).not.toHaveBeenCalled();
    expect(recordRefsRun).toHaveBeenCalledTimes(1);
    expect(recordRefsRun.mock.calls[0]![0]).toBe("v-caliper-2");
    expect(vi.mocked(setReadonly)).toHaveBeenCalledWith("/vault/Brakes/caliper.sldprt", true);
    expect(vi.mocked(setReadonly)).toHaveBeenCalledWith("/vault/Brakes/Rotors/front.sldprt", true);
  });

  it("leaves a file writable when it was saved again during the upload", async () => {
    checkInRun.mockResolvedValue({ id: "v-caliper-2", file_id: "caliper", sha256: "x", version_num: 2 });
    statMock
      .mockResolvedValueOnce({ mtime: new Date(1000) })
      .mockResolvedValueOnce({ mtime: new Date(2000) });
    renderDialog("checkin", baseCtx({
      locks: [lock("caliper", ME)],
      localFiles: [local("Brakes/caliper.sldprt", "edited", false)],
    }));
    await act(async () => {}); // ledger load
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /check in 1 file/i })); });
    await waitFor(() => expect(screen.getByText(/checked in 1 of 1 file/i)).toBeInTheDocument());
    expect(vi.mocked(setReadonly)).not.toHaveBeenCalled();
    expect(screen.getByText(/saved again during the upload/i)).toBeInTheDocument();
  });

  it("needs a local vault folder", async () => {
    renderDialog("checkin", baseCtx({ vaultRoot: null, localFiles: null, locks: [lock("caliper", ME)] }));
    await act(async () => {}); // ledger load
    expect(screen.getByText(/pick a local vault folder first/i)).toBeInTheDocument();
  });
});
