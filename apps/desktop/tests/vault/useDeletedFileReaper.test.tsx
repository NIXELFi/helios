import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDeletedFileReaper } from "../../src/modules/vault/data/useDeletedFileReaper";
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
});
