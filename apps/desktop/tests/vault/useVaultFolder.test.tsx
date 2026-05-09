import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultFolder } from "../../src/modules/vault/data/useVaultFolder";

describe("useVaultFolder", () => {
  beforeEach(() => localStorage.clear());

  it("starts null when nothing is stored", () => {
    const { result } = renderHook(() => useVaultFolder());
    expect(result.current.path).toBeNull();
  });

  it("persists a path to localStorage", () => {
    const { result } = renderHook(() => useVaultFolder());
    act(() => { result.current.setPath("/Users/me/Vault"); });
    expect(result.current.path).toBe("/Users/me/Vault");
    expect(localStorage.getItem("helios.vault.localFolder")).toBe("/Users/me/Vault");
  });

  it("clears the stored path", () => {
    localStorage.setItem("helios.vault.localFolder", "/x");
    const { result } = renderHook(() => useVaultFolder());
    expect(result.current.path).toBe("/x");
    act(() => { result.current.clear(); });
    expect(result.current.path).toBeNull();
    expect(localStorage.getItem("helios.vault.localFolder")).toBeNull();
  });
});
