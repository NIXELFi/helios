import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaultAccess } from "../../src/modules/vault/data/useVaultAccess";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";

/** Mock the `rpc("pdm_has_vault_access")` probe (20260714030000): access is
 *  a single boolean — a legacy pdm.user_roles row OR an Org & Access role
 *  carrying vault.view both count, and the server owns that logic. */
function mockClient(hasAccess: boolean | null, error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: vi.fn().mockResolvedValue({ data: hasAccess, error }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useVaultAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("probe true → member (covers legacy rows AND capability-only members)", async () => {
    const c = mockClient(true);
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).not.toBe("loading"));
    expect(result.current.status).toBe("member");
    expect(result.current.error).toBeNull();
    expect((c.rpc as any).mock.calls[0][0]).toBe("pdm_has_vault_access");
  });

  it("probe false → no-role (authenticated but not yet granted)", async () => {
    const c = mockClient(false);
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("no-role"));
    expect(result.current.error).toBeNull();
  });

  it("a probe error surfaces as the error status with the message", async () => {
    const c = mockClient(null, { message: "function pdm_has_vault_access does not exist" });
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/pdm_has_vault_access/);
  });

  it("a THROWN probe (stub client without rpc) is an error, not a crash", async () => {
    const c = { auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    } } as any;
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});
