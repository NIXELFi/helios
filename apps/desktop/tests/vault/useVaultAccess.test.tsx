import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaultAccess } from "../../src/modules/vault/data/useVaultAccess";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";

/** Mock the `from("user_roles").select("role").eq("user_id", id).limit(1)`
 *  chain. `rows` is what the terminal limit() resolves with. */
function mockClient(rows: any[], error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: rows, error }),
        }),
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useVaultAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a user with MULTIPLE role rows (global + per-vault) is a member, not an error", async () => {
    // Regression: the lookup used .maybeSingle(), which errors on >1 row.
    // Per-vault roles (20260531000000) make multiple rows legitimate, so a
    // real member was shown the backend-misconfig 'error' screen.
    const c = mockClient([{ role: "editor" }, { role: "admin" }]);
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).not.toBe("loading"));
    expect(result.current.status).toBe("member");
    expect(result.current.error).toBeNull();
  });

  it("a single role row is a member", async () => {
    const c = mockClient([{ role: "viewer" }]);
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("member"));
  });

  it("no rows → no-role (authenticated but not yet granted)", async () => {
    const c = mockClient([]);
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("no-role"));
    expect(result.current.error).toBeNull();
  });

  it("a query error surfaces as the error status with the message", async () => {
    const c = mockClient([], { message: "relation pdm.user_roles does not exist" });
    const { result } = renderHook(() => useVaultAccess(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/user_roles/);
  });
});
