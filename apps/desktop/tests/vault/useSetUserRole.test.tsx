import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useSetUserRole } from "../../src/modules/vault/data/useSetUserRole";
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

describe("useSetUserRole", () => {
  it("calls pdm_set_user_role and returns { ok: true, error: null } on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useSetUserRole(), { wrapper: wrap(c) });
    let ret: { ok: boolean; error: Error | null } | undefined;
    await act(async () => {
      ret = await result.current.run("user2", "editor");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedArgs).toEqual({
      name: "pdm_set_user_role",
      args: { p_target: "user2", p_role: "editor" },
    });
    expect(ret).toEqual({ ok: true, error: null });
  });

  it("returns { ok: false, error } carrying the server message, routed through friendlyPgError", async () => {
    // P0001 = RAISE EXCEPTION from the SECURITY DEFINER RPC; friendlyPgError
    // passes its hand-authored body through verbatim.
    const c = mockClient({ code: "P0001", message: "only the owner may grant admin" });
    const { result } = renderHook(() => useSetUserRole(), { wrapper: wrap(c) });
    let ret: { ok: boolean; error: Error | null } | undefined;
    await act(async () => {
      ret = await result.current.run("user2", "admin");
    });
    expect(ret?.ok).toBe(false);
    expect(ret?.error?.message).toContain("only the owner may grant admin");
    // The returned error matches the hook's stored error.
    expect(result.current.error?.message).toContain("only the owner may grant admin");
  });
});
