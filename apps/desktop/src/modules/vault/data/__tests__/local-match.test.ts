import { describe, it, expect } from "vitest";
import { matchLocal, vaultRelativePath } from "../local-match";
import type { VaultFile, Version } from "../types";
import type { LocalFile } from "../useLocalFolderScan";

function file(name: string, folder_id: string | null = null): VaultFile {
  return {
    id: "f1",
    vault_id: "v1",
    folder_id,
    name,
    latest_version_id: "ver1",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function version(sha: string): Version {
  return {
    id: "ver1",
    file_id: "f1",
    version_num: 1,
    sha256: sha,
    size_bytes: 1,
    author_id: null,
    comment: null,
    parent_version_id: null,
    revision: null,
    properties: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function local(relativePath: string, sha: string): LocalFile {
  return {
    basename: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `C:/vault/${relativePath}`,
    sha256: sha,
    sizeBytes: 1,
  };
}

describe("vaultRelativePath", () => {
  it("passes ordinary names through unchanged", () => {
    expect(vaultRelativePath(file("Chassis FINAL.SLDPRT"), [])).toBe("Chassis FINAL.SLDPRT");
  });

  it("sanitizes the file name the same way the download path (localDestPath) does", () => {
    // A DB name containing a path separator is written to disk SANITIZED by
    // localDestPath (sanitizePathSegment turns "/" and "\\" into "_"). The
    // expected relative path must sanitize identically, or the on-disk copy
    // never matches → it looks "vault-only" and re-downloads forever.
    expect(vaultRelativePath(file("26-01/REV-A.SLDPRT"), [])).toBe("26-01_REV-A.SLDPRT");
  });
});

describe("matchLocal", () => {
  it("matches an ordinary on-disk copy as synced", () => {
    const res = matchLocal(
      file("part.SLDPRT"),
      [local("part.SLDPRT", "abc")],
      new Map([["f1", [version("abc")]]]),
      [],
    );
    expect(res.status).toBe("synced");
    expect(res.local?.relativePath).toBe("part.SLDPRT");
  });

  it("matches a file whose name needed sanitizing (previously mis-flagged vault-only)", () => {
    const res = matchLocal(
      file("26-01/REV-A.SLDPRT"),
      [local("26-01_REV-A.SLDPRT", "abc")],
      new Map([["f1", [version("abc")]]]),
      [],
    );
    expect(res.status).toBe("synced");
    expect(res.local?.relativePath).toBe("26-01_REV-A.SLDPRT");
  });
});
