import { describe, it, expect } from "vitest";
import { isSafeVaultRelativePath, resolveVaultForPath } from "../BridgeOpHandler";
import type { Vault } from "../data/types";

/**
 * Unit tests for the bridge `/add` path confinement.
 *
 * The SOLIDWORKS add-in bridge's `add` op forwards a caller-supplied local path
 * to the UI, which resolves the owning vault and then reads that exact path
 * verbatim (useAddLocalFile -> readFile(absolutePath)). The vault-root match is
 * a lexical `startsWith`, so a traversing path like `<vroot>/../../secret` would
 * pass containment while opening a file OUTSIDE the vault. A caller holding the
 * per-launch loopback token could use that to pull an arbitrary local file
 * (e.g. an SSH key) into the vault. resolveVaultForPath must refuse it.
 *
 * The same resolver now also gates the other two path-taking bridge ops:
 * `checkin` (arbitrary-file READ without it) and `getLatest` (arbitrary-file
 * WRITE without it — drop a blob at any caller-chosen path). All three ops
 * refuse paths that don't resolve to a spot inside a vault folder.
 */
describe("isSafeVaultRelativePath", () => {
  it("accepts an ordinary nested relative path", () => {
    expect(isSafeVaultRelativePath("Chassis/frame/x.sldprt")).toBe(true);
    expect(isSafeVaultRelativePath("x.sldprt")).toBe(true);
  });

  it("rejects parent-traversal segments", () => {
    expect(isSafeVaultRelativePath("../secret")).toBe(false);
    expect(isSafeVaultRelativePath("a/../../secret")).toBe(false);
    expect(isSafeVaultRelativePath("a/../b")).toBe(false);
  });

  it("rejects current-dir, empty, absolute, and drive-relative forms", () => {
    expect(isSafeVaultRelativePath("./x")).toBe(false);
    expect(isSafeVaultRelativePath("")).toBe(false);
    expect(isSafeVaultRelativePath("a//b")).toBe(false);
    expect(isSafeVaultRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeVaultRelativePath("C:secret")).toBe(false);
  });
});

describe("resolveVaultForPath — vault-root confinement", () => {
  const vaults = [{ id: "vault-a", name: "SDM26" }] as unknown as Vault[];
  const root = "C:\\Users\\nick\\Helios";

  it("resolves a file genuinely under the vault folder", () => {
    const r = resolveVaultForPath("C:\\Users\\nick\\Helios\\SDM26\\Chassis\\x.sldprt", root, vaults);
    expect(r).toEqual({ vaultId: "vault-a", relativePath: "Chassis/x.sldprt" });
  });

  it("refuses a traversing path that lexically starts with the vault root", () => {
    // Escapes to the user's SSH key despite starting with <root>/SDM26/.
    expect(
      resolveVaultForPath("C:\\Users\\nick\\Helios\\SDM26\\..\\..\\..\\.ssh\\id_rsa", root, vaults),
    ).toBeNull();
    // Forward-slash variant.
    expect(
      resolveVaultForPath("C:/Users/nick/Helios/SDM26/../../secret.env", root, vaults),
    ).toBeNull();
  });

  it("refuses a path outside any vault folder", () => {
    expect(resolveVaultForPath("C:\\Users\\nick\\Documents\\x.sldprt", root, vaults)).toBeNull();
  });
});
