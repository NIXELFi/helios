import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultFolder } from "../../src/modules/vault/data/useVaultFolder";

const V1 = "00000000-0000-0000-0000-000000000001";
const V2 = "00000000-0000-0000-0000-000000000002";

describe("useVaultFolder", () => {
  beforeEach(() => localStorage.clear());

  it("starts null when nothing is stored", () => {
    const { result } = renderHook(() => useVaultFolder(V1));
    expect(result.current.path).toBeNull();
  });

  it("persists a path scoped to the vault id", () => {
    const { result } = renderHook(() => useVaultFolder(V1));
    act(() => { result.current.setPath("/Users/me/V1"); });
    expect(result.current.path).toBe("/Users/me/V1");
    // Storage is a JSON map keyed by vault id.
    const raw = localStorage.getItem("helios.vault.localFolder");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[V1]).toBe("/Users/me/V1");
    expect(parsed[V2]).toBeUndefined();
  });

  it("keeps per-vault paths separate", () => {
    const { result: r1 } = renderHook(() => useVaultFolder(V1));
    const { result: r2 } = renderHook(() => useVaultFolder(V2));
    act(() => { r1.current.setPath("/v1"); });
    act(() => { r2.current.setPath("/v2"); });
    expect(r1.current.path).toBe("/v1");
    expect(r2.current.path).toBe("/v2");
  });

  it("clear() removes only this vault's entry", () => {
    localStorage.setItem(
      "helios.vault.localFolder",
      JSON.stringify({ [V1]: "/v1", [V2]: "/v2" }),
    );
    const { result } = renderHook(() => useVaultFolder(V1));
    expect(result.current.path).toBe("/v1");
    act(() => { result.current.clear(); });
    expect(result.current.path).toBeNull();
    const parsed = JSON.parse(localStorage.getItem("helios.vault.localFolder")!);
    expect(parsed[V1]).toBeUndefined();
    expect(parsed[V2]).toBe("/v2");
  });

  it("migrates a legacy bare-string value to the calling vault id", () => {
    // Previous versions stored a single global path here.
    localStorage.setItem("helios.vault.localFolder", "/legacy/path");
    const { result } = renderHook(() => useVaultFolder(V1));
    expect(result.current.path).toBe("/legacy/path");
    // The stored value is rewritten as a JSON map.
    const parsed = JSON.parse(localStorage.getItem("helios.vault.localFolder")!);
    expect(parsed[V1]).toBe("/legacy/path");
  });

  it("returns null when called with vaultId=null", () => {
    localStorage.setItem(
      "helios.vault.localFolder",
      JSON.stringify({ [V1]: "/v1" }),
    );
    const { result } = renderHook(() => useVaultFolder(null));
    expect(result.current.path).toBeNull();
  });
});
