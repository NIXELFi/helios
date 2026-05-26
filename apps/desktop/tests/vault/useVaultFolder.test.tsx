import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultFolder, sanitizeVaultName } from "../../src/modules/vault/data/useVaultFolder";

describe("useVaultFolder", () => {
  beforeEach(() => localStorage.clear());

  it("starts with null root + null path when nothing is stored", () => {
    const { result } = renderHook(() => useVaultFolder({ vaultName: "SDM26" }));
    expect(result.current.root).toBeNull();
    expect(result.current.path).toBeNull();
  });

  it("setRoot persists and derives per-vault paths", () => {
    const { result } = renderHook(() => useVaultFolder({ vaultName: "SDM26" }));
    act(() => { result.current.setRoot("/Users/me/Helios"); });
    expect(result.current.root).toBe("/Users/me/Helios");
    expect(result.current.path).toBe("/Users/me/Helios/SDM26");
    expect(localStorage.getItem("helios.vault.localFolder")).toBe("/Users/me/Helios");
  });

  it("returns different paths for different vault names off the same root", () => {
    const { result: r1 } = renderHook(() => useVaultFolder({ vaultName: "SDM26" }));
    const { result: r2 } = renderHook(() => useVaultFolder({ vaultName: "SDM27" }));
    act(() => { r1.current.setRoot("/Users/me/Helios"); });
    // Both hooks should see the same root after the broadcast.
    expect(r1.current.root).toBe("/Users/me/Helios");
    expect(r2.current.root).toBe("/Users/me/Helios");
    expect(r1.current.path).toBe("/Users/me/Helios/SDM26");
    expect(r2.current.path).toBe("/Users/me/Helios/SDM27");
  });

  it("clear() removes the root + nulls every derived path", () => {
    localStorage.setItem("helios.vault.localFolder", "/Users/me/Helios");
    const { result } = renderHook(() => useVaultFolder({ vaultName: "SDM26" }));
    expect(result.current.path).toBe("/Users/me/Helios/SDM26");
    act(() => { result.current.clear(); });
    expect(result.current.root).toBeNull();
    expect(result.current.path).toBeNull();
    expect(localStorage.getItem("helios.vault.localFolder")).toBeNull();
  });

  it("recovers a root from a legacy JSON map by using a stored path as-is", () => {
    // A previous build stripped one path level here, which on /Users/me/Vault
    // gave a root of /Users/me and put SDM26 sync output outside the user's
    // chosen folder. The migration now uses the stored path AS the root.
    localStorage.setItem(
      "helios.vault.localFolder",
      JSON.stringify({ "v1": "/Users/me/Helios/Vault" }),
    );
    const { result } = renderHook(() => useVaultFolder({ vaultName: "SDM26" }));
    expect(result.current.root).toBe("/Users/me/Helios/Vault");
    expect(result.current.path).toBe("/Users/me/Helios/Vault/SDM26");
  });

  it("returns null path when vault name is null", () => {
    localStorage.setItem("helios.vault.localFolder", "/Users/me/Helios");
    const { result } = renderHook(() => useVaultFolder({ vaultName: null }));
    expect(result.current.root).toBe("/Users/me/Helios");
    expect(result.current.path).toBeNull();
  });

  it("sanitizes vault names with filesystem-unsafe characters", () => {
    expect(sanitizeVaultName("SDM26")).toBe("SDM26");
    expect(sanitizeVaultName("a/b")).toBe("a_b");
    expect(sanitizeVaultName("foo:bar?")).toBe("foo_bar_");
  });
});
