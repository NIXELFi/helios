import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useIsAdmin } from "../../src/modules/vault/data/useIsAdmin";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any, rpcResult: any): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: null }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useIsAdmin", () => {
  it("returns false when there is no user", async () => {
    const c = mockClient(null, false);
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(c) });
    // With no session, effect sets false immediately
    await waitFor(() => expect(result.current).toBe(false));
    expect((c.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("returns true when pdm_is_admin RPC returns true", async () => {
    const c = mockClient({ user: { id: "admin1" } }, true);
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("returns false when pdm_is_admin RPC returns false", async () => {
    const c = mockClient({ user: { id: "u1" } }, false);
    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrap(c) });
    // Initial state is false; after RPC resolves it should stay false
    await waitFor(() => {
      expect((c.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("pdm_is_admin");
    });
    expect(result.current).toBe(false);
  });
});
