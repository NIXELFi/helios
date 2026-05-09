import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useForceUnlock } from "../../src/modules/vault/data/useForceUnlock";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let capturedArgs: any = null;

function mockClient(error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "admin1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => {
      capturedArgs = { name, args };
      return Promise.resolve({ data: null, error });
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useForceUnlock", () => {
  it("calls pdm_force_unlock RPC with lock_id and reason, returns true on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useForceUnlock(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("lock1", "admin override");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedArgs).toEqual({
      name: "pdm_force_unlock",
      args: { p_lock_id: "lock1", p_reason: "admin override" },
    });
    expect(returnValue).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces RPC errors and returns false", async () => {
    const c = mockClient({ message: "not an admin" });
    const { result } = renderHook(() => useForceUnlock(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("lock1", "reason");
    });
    expect(returnValue).toBe(false);
    expect(result.current.error?.message).toContain("not an admin");
  });
});
