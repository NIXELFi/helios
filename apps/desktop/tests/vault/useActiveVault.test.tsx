import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useActiveVault } from "../../src/modules/vault/data/useActiveVault";

function clientWith(vaults: Array<{ id: string; name: string; created_at: string }>): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "t@x" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      if (table === "vaults") {
        return { select: () => Promise.resolve({ data: vaults.map((v) => ({ ...v, created_by: "u1" })), error: null }) };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

const wrap = (client: SupabaseClient) => ({ children }: { children: React.ReactNode }) =>
  <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;

describe("useActiveVault", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to the most-recently-created vault on first load", async () => {
    const client = clientWith([
      { id: "old", name: "OLD", created_at: "2024-01-01T00:00:00Z" },
      { id: "new", name: "NEW", created_at: "2026-05-11T18:32:17Z" },
      { id: "mid", name: "MID", created_at: "2025-06-01T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("new"));
    expect(result.current.activeVault?.name).toBe("NEW");
    expect(localStorage.getItem("helios.vault.activeVaultId")).toBe("new");
  });

  it("respects a stored id when it matches a current vault", async () => {
    localStorage.setItem("helios.vault.activeVaultId", "old");
    const client = clientWith([
      { id: "old", name: "OLD", created_at: "2024-01-01T00:00:00Z" },
      { id: "new", name: "NEW", created_at: "2026-05-11T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("old"));
  });

  it("falls back when stored id no longer exists (revoked / deleted)", async () => {
    localStorage.setItem("helios.vault.activeVaultId", "gone");
    const client = clientWith([
      { id: "v1", name: "V1", created_at: "2026-05-11T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("v1"));
    expect(localStorage.getItem("helios.vault.activeVaultId")).toBe("v1");
  });

  it("setActiveVaultId persists and updates", async () => {
    const client = clientWith([
      { id: "a", name: "A", created_at: "2026-01-01T00:00:00Z" },
      { id: "b", name: "B", created_at: "2025-01-01T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("a"));
    act(() => { result.current.setActiveVaultId("b"); });
    await waitFor(() => expect(result.current.activeVaultId).toBe("b"));
    expect(localStorage.getItem("helios.vault.activeVaultId")).toBe("b");
  });

  it("returns null activeVaultId when the user has no vaults", async () => {
    const client = clientWith([]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeVaultId).toBeNull();
    expect(result.current.activeVault).toBeNull();
  });
});
