import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useIsVaultAdmin, useCanEditVault } from "../../src/modules/vault/data/useVaultRole";

let rpcCalls: { name: string; args: any }[] = [];
function mockClient(result: boolean): SupabaseClient {
  rpcCalls = [];
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => { rpcCalls.push({ name, args }); return Promise.resolve({ data: result, error: null }); },
  } as any;
}
const wrap = (c: SupabaseClient) => ({ children }: { children: ReactNode }) =>
  <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useIsVaultAdmin / useCanEditVault", () => {
  it("calls pdm_is_admin_in with the vault id and returns the result", async () => {
    const c = mockClient(true);
    const { result } = renderHook(() => useIsVaultAdmin("v1" as any), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe(true));
    expect(rpcCalls).toContainEqual({ name: "pdm_is_admin_in", args: { p_vault_id: "v1" } });
  });

  it("calls pdm_can_edit_in with the vault id", async () => {
    const c = mockClient(false);
    const { result } = renderHook(() => useCanEditVault("v2" as any), { wrapper: wrap(c) });
    await waitFor(() => expect(rpcCalls).toContainEqual({ name: "pdm_can_edit_in", args: { p_vault_id: "v2" } }));
    expect(result.current).toBe(false);
  });

  it("returns false (no RPC) when vaultId is null", async () => {
    const c = mockClient(true);
    const { result } = renderHook(() => useCanEditVault(null), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe(false));
    expect(rpcCalls).toHaveLength(0);
  });
});
