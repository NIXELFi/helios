import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useRevokeUserRole } from "../../src/modules/vault/data/useRevokeUserRole";
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

describe("useRevokeUserRole", () => {
  it("calls pdm_revoke_user_role and returns { ok: true, error: null } on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useRevokeUserRole(), { wrapper: wrap(c) });
    let ret: { ok: boolean; error: Error | null } | undefined;
    await act(async () => {
      ret = await result.current.run("user2");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedArgs).toEqual({
      name: "pdm_revoke_user_role",
      args: { p_target: "user2" },
    });
    expect(ret).toEqual({ ok: true, error: null });
  });

  it("returns { ok: false, error } carrying the server message", async () => {
    const c = mockClient({ code: "P0001", message: "owner row can't be revoked" });
    const { result } = renderHook(() => useRevokeUserRole(), { wrapper: wrap(c) });
    let ret: { ok: boolean; error: Error | null } | undefined;
    await act(async () => {
      ret = await result.current.run("user2");
    });
    expect(ret?.ok).toBe(false);
    expect(ret?.error?.message).toContain("owner row can't be revoked");
    expect(result.current.error?.message).toContain("owner row can't be revoked");
  });
});
