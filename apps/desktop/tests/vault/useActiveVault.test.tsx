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

function clientThatErrors(message: string): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "t@x" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => ({ select: () => Promise.resolve({ data: null, error: new Error(message) }) }),
  } as any;
}

const wrap = (client: SupabaseClient) => ({ children }: { children: React.ReactNode }) =>
  <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;

describe("useActiveVault", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to the newest season name (natural order) on first load", async () => {
    // Policy change 2026-06-12: creation-date order put users in last year's
    // vault by default. The fallback is now natural name order DESCENDING, so
    // SDM27 beats SDM26 regardless of which vault row was created first.
    const client = clientWith([
      { id: "sdm27", name: "SDM27", created_at: "2024-01-01T00:00:00Z" }, // oldest row, newest season
      { id: "sdm26", name: "SDM26", created_at: "2026-05-11T18:32:17Z" },
      { id: "sdm25", name: "SDM25", created_at: "2025-06-01T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("sdm27"));
    expect(result.current.activeVault?.name).toBe("SDM27");
    expect(localStorage.getItem("helios.vault.activeVaultId")).toBe("sdm27");
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
      // Name-desc fallback resolves "a" (SDM27) first; the explicit selection
      // of "b" below must win and persist.
      { id: "a", name: "SDM27", created_at: "2025-01-01T00:00:00Z" },
      { id: "b", name: "SDM26", created_at: "2026-01-01T00:00:00Z" },
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
    // No vaults is NOT an error.
    expect(result.current.error).toBeNull();
  });

  it("surfaces the useVaults error so the switcher can tell load-failed from no-vaults (H4)", async () => {
    // Repro of the 2026-05-29 audit H4: useActiveVault dropped useVaults's
    // error, so a failed load looked identical to an empty vault list.
    const client = clientThatErrors("RLS blocked");
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("RLS blocked");
    expect(result.current.activeVaultId).toBeNull();
  });

  it("does not overwrite a freshly-set vault id when useVaults hasn't refetched yet", async () => {
    // Repro of the bug surfaced in the 2026-05-25 audit: useCreateVault
    // succeeds, the UI calls setActiveVaultId(newId), but the useVaults cache
    // still shows the old list. Without the fix, resolution falls back to
    // "most-recently-created" and silently overwrites the user's choice.
    const client = clientWith([
      { id: "a", name: "A", created_at: "2026-05-01T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useActiveVault(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.activeVaultId).toBe("a"));

    // User creates vault "b" and immediately selects it. useVaults still
    // returns only [A] until the next refetch lands.
    act(() => { result.current.setActiveVaultId("b"); });

    // Resolution must trust the user's choice even though "b" isn't in the
    // cached vaults list yet. Without the fix, this asserts "a" because the
    // effect overwrites stored back to the fallback.
    await waitFor(() => expect(result.current.activeVaultId).toBe("b"));
    expect(localStorage.getItem("helios.vault.activeVaultId")).toBe("b");
  });
});
