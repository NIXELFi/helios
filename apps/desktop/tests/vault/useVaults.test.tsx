import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaults } from "../../src/modules/vault/data/useVaults";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(rows: any[], error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => ({
      select: () => Promise.resolve({ data: rows, error }),
    }),
  } as any;
}

function makeWrapper(client: SupabaseClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
  };
}

describe("useVaults", () => {
  it("returns vaults after the query resolves", async () => {
    const rows = [{ id: "v1", name: "sdm26", created_at: "2026-01-01", created_by: "u1" }];
    const { result } = renderHook(() => useVaults(), {
      wrapper: makeWrapper(mockClient(rows)),
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(rows);
    expect(result.current.error).toBeNull();
  });

  it("surfaces errors", async () => {
    const { result } = renderHook(() => useVaults(), {
      wrapper: makeWrapper(mockClient([], new Error("RLS blocked"))),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("RLS blocked");
  });
});
