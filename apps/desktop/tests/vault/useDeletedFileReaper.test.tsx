import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDeletedFileReaper } from "../../src/modules/vault/data/useDeletedFileReaper";
import { onReaperHeldBack } from "../../src/modules/vault/data/local-delete-events";
import type { VaultFile, Folder } from "../../src/modules/vault/data/types";
import type { LocalFile } from "../../src/modules/vault/data/useLocalFolderScan";

const removeMock = vi.fn().mockResolvedValue(undefined);
const setReadonlyMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-fs", () => ({
  remove: (...args: any[]) => removeMock(...args),
}));
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: (...args: any[]) => setReadonlyMock(...args),
  flipSwReadonly: vi.fn(),
}));

// Controllable ledger for the orphan pass: normalized rel → sha. loadLedger
// serves it; removals are captured. Existing tests never pass vaultId, so the
// ledger halves are inert for them.
const ledgerEntries = vi.hoisted(() => new Map<string, string>());
const ledgerRemoveCalls = vi.hoisted(() => [] as Array<{ vaultId: string; rel: string }>);
vi.mock("../../src/modules/vault/data/sync-ledger", () => ({
  loadLedger: vi.fn(async () => {
    const entries: Record<string, { sha256: string; recordedAt: string }> = {};
    for (const [rel, sha] of ledgerEntries) entries[rel] = { sha256: sha, recordedAt: "t" };
    return { entries };
  }),
  ledgerRemove: vi.fn((vaultId: string, rel: string) => {
    ledgerRemoveCalls.push({ vaultId, rel });
    return Promise.resolve();
  }),
}));
function seedLedger(rel: string, sha: string) {
  ledgerEntries.set(rel.normalize("NFC").toLowerCase(), sha);
}

function delFile(id: string, name: string, folder_id: string | null = null): VaultFile {
  return {
    id, vault_id: "v1", folder_id, name, latest_version_id: null,
    created_at: "x", deleted_at: "2026-06-04T00:00:00Z",
  } as VaultFile;
}
function local(relativePath: string, absolutePath: string): LocalFile {
  return {
    basename: relativePath.split("/").pop()!,
    relativePath, absolutePath, sha256: "deadbeef", sizeBytes: 1, readonly: true,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("useDeletedFileReaper", () => {
  beforeEach(() => {
    removeMock.mockClear();
    setReadonlyMock.mockClear();
    ledgerEntries.clear();
    ledgerRemoveCalls.length = 0;
  });

  it("removes the local copy of a deleted file, clearing read-only FIRST", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [local("frame.sldprt", "C:/vault/SDM25/frame.sldprt")],
        folders: [],
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(setReadonlyMock).toHaveBeenCalledWith("C:/vault/SDM25/frame.sldprt", false);
    expect(removeMock).toHaveBeenCalledWith("C:/vault/SDM25/frame.sldprt");
    // The read-only bit MUST be cleared before the delete (Windows refuses to
    // remove a read-only file).
    expect(setReadonlyMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeMock.mock.invocationCallOrder[0]!,
    );
  });

  it("does nothing for a deleted file with no local copy on disk", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [local("other.sldprt", "C:/vault/SDM25/other.sldprt")],
        folders: [],
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("matches on full path so same-named files in different folders don't cross-match", async () => {
    const folders: Folder[] = [
      { id: "fo1", vault_id: "v1", parent_id: null, name: "Aero", created_at: "x" },
    ];
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        // deleted file is Aero/part.sldprt
        deletedFiles: [delFile("f1", "part.sldprt", "fo1")],
        // local file is root part.sldprt — a DIFFERENT path; must not be removed
        localFiles: [local("part.sldprt", "C:/vault/SDM25/part.sldprt")],
        folders,
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("removes the right copy when names collide across folders", async () => {
    const folders: Folder[] = [
      { id: "fo1", vault_id: "v1", parent_id: null, name: "Aero", created_at: "x" },
    ];
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "part.sldprt", "fo1")], // Aero/part.sldprt
        localFiles: [
          local("part.sldprt", "C:/vault/SDM25/part.sldprt"),
          local("Aero/part.sldprt", "C:/vault/SDM25/Aero/part.sldprt"),
        ],
        folders,
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(removeMock).toHaveBeenCalledWith("C:/vault/SDM25/Aero/part.sldprt");
  });

  // ── Writable-copy guard (2026-06-09 audit CRITICAL) ──────────────────────
  // The read-only bit is the module-wide "clean copy" marker: writable means
  // checked out / possible unsaved edits. A vault-side delete must never
  // destroy such a copy.

  it("NEVER removes a writable local copy (possible unsaved edits) — surfaces it instead", async () => {
    const heldBack: string[][] = [];
    const unsub = onReaperHeldBack((names) => heldBack.push(names));
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [{ ...local("frame.sldprt", "C:/vault/SDM25/frame.sldprt"), readonly: false }],
        folders: [],
      }),
    );
    await waitFor(() => expect(heldBack).toHaveLength(1));
    unsub();
    expect(removeMock).not.toHaveBeenCalled();
    expect(setReadonlyMock).not.toHaveBeenCalled();
    expect(heldBack[0]).toEqual(["frame.sldprt"]);
  });

  it("treats an unknown read-only bit (stat unavailable) as writable — kept on disk", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [{ ...local("frame.sldprt", "C:/vault/SDM25/frame.sldprt"), readonly: undefined }],
        folders: [],
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("warns once per held-back file, not on every reap pass", async () => {
    const heldBack: string[][] = [];
    const unsub = onReaperHeldBack((names) => heldBack.push(names));
    const props = {
      enabled: true,
      deletedFiles: [delFile("f1", "frame.sldprt")],
      folders: [] as Folder[],
    };
    const { rerender } = renderHook(
      ({ localFiles }: { localFiles: LocalFile[] }) =>
        useDeletedFileReaper({ ...props, localFiles }),
      {
        initialProps: {
          localFiles: [{ ...local("frame.sldprt", "C:/vault/SDM25/frame.sldprt"), readonly: false }],
        },
      },
    );
    await waitFor(() => expect(heldBack).toHaveLength(1));
    // New array identity (a fresh scan) re-fires the effect — no second event.
    rerender({
      localFiles: [{ ...local("frame.sldprt", "C:/vault/SDM25/frame.sldprt"), readonly: false }],
    });
    await settle();
    unsub();
    expect(heldBack).toHaveLength(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("still reaps the clean read-only copies in the same pass as a held-back one", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "dirty.sldprt"), delFile("f2", "clean.sldprt")],
        localFiles: [
          { ...local("dirty.sldprt", "C:/vault/SDM25/dirty.sldprt"), readonly: false },
          local("clean.sldprt", "C:/vault/SDM25/clean.sldprt"),
        ],
        folders: [],
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(removeMock).toHaveBeenCalledWith("C:/vault/SDM25/clean.sldprt");
  });

  it("does nothing when disabled (manual download mode)", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: false,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [local("frame.sldprt", "C:/vault/SDM25/frame.sldprt")],
        folders: [],
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("calls onReaped once after removing at least one file", async () => {
    const onReaped = vi.fn();
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "frame.sldprt")],
        localFiles: [local("frame.sldprt", "C:/vault/SDM25/frame.sldprt")],
        folders: [],
        onReaped,
      }),
    );
    await waitFor(() => expect(onReaped).toHaveBeenCalledTimes(1));
  });

  // ── Folder-dir reaping (T9) ──────────────────────────────────────────────

  function delFolder(id: string, name: string, parent_id: string | null = null): Folder {
    return {
      id, vault_id: "v1", parent_id, name, created_at: "x",
      deleted_at: "2026-06-05T00:00:00Z",
    } as Folder;
  }

  it("removes an empty deleted-folder dir (non-recursive)", async () => {
    const deletedFolder = delFolder("fd1", "OldParts");
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [],
        folders: [],
        deletedFolders: [deletedFolder],
        vaultRoot: "C:/vault/SDM25",
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(removeMock).toHaveBeenCalledWith("C:/vault/SDM25/OldParts", { recursive: false });
  });

  it("leaves non-empty deleted-folder dir when remove() throws (safe skip)", async () => {
    // Simulate the dir being non-empty — remove() rejects.
    removeMock.mockRejectedValueOnce(new Error("ENOTEMPTY"));
    const deletedFolder = delFolder("fd1", "OldParts");
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [],
        folders: [],
        deletedFolders: [deletedFolder],
        vaultRoot: "C:/vault/SDM25",
      }),
    );
    await settle();
    // remove was attempted but failed — onReaped must NOT have been called.
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("removes child folder before parent (deepest-first ordering)", async () => {
    // parent: "Chassis", child: "Chassis/Frame"
    const parent = delFolder("fd-parent", "Chassis");
    const child = delFolder("fd-child", "Frame", "fd-parent");
    // Both live in deletedFolders; combined lookup resolves child's path.
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [],
        folders: [],
        deletedFolders: [parent, child],
        vaultRoot: "C:/vault/SDM25",
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(2));
    // child (depth 2) must be attempted before parent (depth 1).
    const calls = removeMock.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe("C:/vault/SDM25/Chassis/Frame");
    expect(calls[1]).toBe("C:/vault/SDM25/Chassis");
  });

  // ── Phantom-change triage 2026-07-23 (F4 + N2) ───────────────────────────

  it("F4: reaps a cascade-deleted file inside a DELETED folder (combined lookup resolves the real path)", async () => {
    // The folder is gone from the LIVE list — resolving against live folders
    // alone collapsed the file's path to the bare basename, which (a) missed
    // this real copy and (b) could match an unrelated root file.
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "part.sldprt", "fd-gone")],
        localFiles: [
          local("Gone/part.sldprt", "C:/vault/SDM25/Gone/part.sldprt"),
          // Unrelated same-named root file — must NOT be touched.
          local("part.sldprt", "C:/vault/SDM25/part.sldprt"),
        ],
        folders: [],
        deletedFolders: [
          { id: "fd-gone", vault_id: "v1", parent_id: null, name: "Gone", created_at: "x", deleted_at: "y" } as Folder,
        ],
        vaultRoot: "C:/vault/SDM25",
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalled());
    const removed = removeMock.mock.calls.map((c) => c[0] as string);
    expect(removed).toContain("C:/vault/SDM25/Gone/part.sldprt");
    expect(removed).not.toContain("C:/vault/SDM25/part.sldprt");
  });

  it("F4: touches nothing when a deleted file's folder is unresolvable even in the combined set", async () => {
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [delFile("f1", "part.sldprt", "hard-vanished")],
        // Same-named clean root file — the pre-fix collapse deleted it.
        localFiles: [local("part.sldprt", "C:/vault/SDM25/part.sldprt")],
        folders: [],
        deletedFolders: [],
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("N2: removes a ledgered clean orphan (remote-move residue) and drops its ledger entry", async () => {
    const folders: Folder[] = [
      { id: "fo-new", vault_id: "v1", parent_id: null, name: "New", created_at: "x" },
      { id: "fo-old", vault_id: "v1", parent_id: null, name: "Old", created_at: "x" },
    ];
    // The file moved Old → New; this machine still has the stale Old copy.
    const live: VaultFile[] = [{
      id: "f1", vault_id: "v1", folder_id: "fo-new", name: "part.sldprt",
      latest_version_id: null, created_at: "x",
    } as VaultFile];
    seedLedger("Old/part.sldprt", "sha-1");
    seedLedger("New/part.sldprt", "sha-1");
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [
          { ...local("Old/part.sldprt", "C:/vault/SDM25/Old/part.sldprt"), sha256: "sha-1" },
          { ...local("New/part.sldprt", "C:/vault/SDM25/New/part.sldprt"), sha256: "sha-1" },
        ],
        folders,
        liveFiles: live,
        vaultRoot: "C:/vault/SDM25",
        vaultId: "v1",
      }),
    );
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(removeMock).toHaveBeenCalledWith("C:/vault/SDM25/Old/part.sldprt");
    expect(ledgerRemoveCalls).toContainEqual({ vaultId: "v1", rel: "Old/part.sldprt" });
  });

  it("N2: keeps writable, un-ledgered, and sha-mismatched local files (never deletes user data)", async () => {
    seedLedger("writable.bin", "sha-1");
    seedLedger("edited.bin", "sha-VAULT");
    // One unrelated live row so the pass actually runs (see the empty-liveFiles
    // guard test below) — none of the candidates map to it.
    const live: VaultFile[] = [{
      id: "f-live", vault_id: "v1", folder_id: null, name: "other.bin",
      latest_version_id: null, created_at: "x",
    } as VaultFile];
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [
          { ...local("writable.bin", "C:/vault/SDM25/writable.bin"), sha256: "sha-1", readonly: false },
          { ...local("unledgered.bin", "C:/vault/SDM25/unledgered.bin"), sha256: "sha-1" },
          { ...local("edited.bin", "C:/vault/SDM25/edited.bin"), sha256: "sha-LOCAL" },
        ],
        folders: [],
        liveFiles: live,
        vaultRoot: "C:/vault/SDM25",
        vaultId: "v1",
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("N2: an EMPTY live list never runs the orphan pass (RLS-revoked membership must not wipe the local tree)", async () => {
    // Membership revocation returns 200-with-zero-rows, not an error — an
    // empty liveFiles makes every ledgered synced copy look orphaned. The
    // pass must refuse to act on an empty live list.
    seedLedger("part.sldprt", "sha-1");
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        // A perfect orphan candidate: readonly, ledgered, sha-matching.
        localFiles: [{ ...local("part.sldprt", "C:/vault/SDM25/part.sldprt"), sha256: "sha-1" }],
        folders: [],
        liveFiles: [],
        vaultRoot: "C:/vault/SDM25",
        vaultId: "v1",
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("N2: skips the orphan pass when a live file's folder is unresolvable (incomplete snapshot)", async () => {
    // If the pass ran against an incomplete folder list, this live file's own
    // local copy would look orphaned and be deleted.
    const live: VaultFile[] = [{
      id: "f1", vault_id: "v1", folder_id: "not-fetched-yet", name: "part.sldprt",
      latest_version_id: null, created_at: "x",
    } as VaultFile];
    seedLedger("Somewhere/part.sldprt", "sha-1");
    renderHook(() =>
      useDeletedFileReaper({
        enabled: true,
        deletedFiles: [],
        localFiles: [
          { ...local("Somewhere/part.sldprt", "C:/vault/SDM25/Somewhere/part.sldprt"), sha256: "sha-1" },
        ],
        folders: [], // folder list hasn't caught up
        liveFiles: live,
        vaultRoot: "C:/vault/SDM25",
        vaultId: "v1",
      }),
    );
    await settle();
    expect(removeMock).not.toHaveBeenCalled();
  });
});
