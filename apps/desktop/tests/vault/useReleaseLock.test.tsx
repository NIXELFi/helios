import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useReleaseLock } from "../../src/modules/vault/data/useReleaseLock";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let capturedArgs: any = null;

function mockClient(error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
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

describe("useReleaseLock", () => {
  it("calls pdm_cancel_checkout RPC with p_file_id and returns true on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useReleaseLock(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("f1");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedArgs).toEqual({ name: "pdm_cancel_checkout", args: { p_file_id: "f1" } });
    expect(returnValue).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces RPC errors and returns false", async () => {
    const c = mockClient({ message: "lock not found" });
    const { result } = renderHook(() => useReleaseLock(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("f1");
    });
    expect(returnValue).toBe(false);
    expect(result.current.error?.message).toContain("lock not found");
  });
});
