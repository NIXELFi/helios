/**
 * findUnmatchedLocal + vaultSnapshotConsistent (phantom-change triage
 * 2026-07-23, F5/F3): "add to vault" candidates must only ever be computed
 * from a coherent single-vault snapshot — cross-vault rows (vault-switch
 * refetch window) or file rows whose folder hasn't been fetched yet make the
 * comparison set wrong and fabricate phantom "add" candidates that auto-add
 * then acts on for real.
 */
import { describe, it, expect } from "vitest";
import { findUnmatchedLocal, vaultSnapshotConsistent } from "../find-unmatched";
import type { Folder, VaultFile } from "../types";
import type { LocalFile } from "../useLocalFolderScan";

function file(id: string, name: string, folderId: string | null = null, vaultId = "v1"): VaultFile {
  return {
    id, vault_id: vaultId, folder_id: folderId, name,
    latest_version_id: null, created_at: "2026-01-01T00:00:00Z",
  };
}

function folder(id: string, name: string, vaultId = "v1"): Folder {
  return { id, vault_id: vaultId, parent_id: null, name, created_at: "2026-01-01T00:00:00Z" };
}

function local(relativePath: string): LocalFile {
  return {
    basename: relativePath.split("/").pop()!,
    relativePath,
    absolutePath: `/root/${relativePath}`,
    sha256: "abc",
    sizeBytes: 1,
  };
}

describe("findUnmatchedLocal", () => {
  it("returns local files with no matching vault row by relative path", () => {
    const folders = [folder("fa", "chassis")];
    const vaultFiles = [file("f1", "a.bin", "fa")];
    const locals = [local("chassis/a.bin"), local("chassis/new.bin")];
    const out = findUnmatchedLocal(vaultFiles, locals, folders);
    expect(out.map((l) => l.relativePath)).toEqual(["chassis/new.bin"]);
  });

  it("matches case-insensitively / NFC-normalized", () => {
    const folders = [folder("fa", "Chassis")];
    const vaultFiles = [file("f1", "A.BIN", "fa")];
    const locals = [local("chassis/a.bin")];
    expect(findUnmatchedLocal(vaultFiles, locals, folders)).toEqual([]);
  });
});

describe("vaultSnapshotConsistent", () => {
  const folders = [folder("fa", "chassis")];
  const vaultFiles = [file("f1", "a.bin", "fa"), file("f2", "root.bin", null)];

  it("accepts a coherent single-vault snapshot", () => {
    expect(vaultSnapshotConsistent("v1", vaultFiles, folders)).toBe(true);
  });

  it("rejects a null/undefined vault id", () => {
    expect(vaultSnapshotConsistent(null, vaultFiles, folders)).toBe(false);
    expect(vaultSnapshotConsistent(undefined, vaultFiles, folders)).toBe(false);
  });

  it("rejects file rows from another vault (switch refetch window)", () => {
    expect(
      vaultSnapshotConsistent("v1", [...vaultFiles, file("fx", "b.bin", null, "v2")], folders),
    ).toBe(false);
  });

  it("rejects folder rows from another vault", () => {
    expect(
      vaultSnapshotConsistent("v1", vaultFiles, [...folders, folder("fb", "susp", "v2")]),
    ).toBe(false);
  });

  it("rejects a file whose folder_id is not in the folder snapshot (realtime race)", () => {
    expect(
      vaultSnapshotConsistent("v1", [...vaultFiles, file("f3", "c.bin", "not-fetched")], folders),
    ).toBe(false);
  });

  it("accepts empty snapshots (nothing to be inconsistent about)", () => {
    expect(vaultSnapshotConsistent("v1", [], [])).toBe(true);
  });
});
