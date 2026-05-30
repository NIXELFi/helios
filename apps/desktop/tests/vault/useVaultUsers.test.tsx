import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaultUsers } from "../../src/modules/vault/data/useVaultUsers";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// The RPC returns a different payload on each call (call 0, call 1, …) so we
// can tell the initial load from a refetch.
function mockClient(responses: Array<{ data: any; error: any }>): SupabaseClient {
  let call = 0;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: vi.fn().mockImplementation(() => {
      const r = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve(r);
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

const row = (id: string, role: string) => ({
  user_id: id,
  email: `${id}@x.com`,
  display_name: id,
  subteam: null,
  role,
  granted_at: null,
  created_at: "x",
});

describe("useVaultUsers", () => {
  it("loads users via the admin RPC", async () => {
    const c = mockClient([{ data: [row("a", "admin")], error: null }]);
    const { result } = renderHook(() => useVaultUsers(), { wrapper: wrap(c) });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("surfaces RPC errors (non-admin caller)", async () => {
    const c = mockClient([{ data: null, error: { message: "not an admin" } }]);
    const { result } = renderHook(() => useVaultUsers(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("not an admin");
    expect(result.current.data).toBeNull();
  });

  it("keeps prior data visible during a background refetch — no loading flash (H4)", async () => {
    // Repro of the 2026-05-29 audit H4: refetch() set loading=true and blanked
    // the whole table after every mutation. A background refetch (data already
    // present) must keep loading=false and keep showing the old rows until the
    // new ones arrive. Only the initial load (data===null) presents as loading.
    let resolveRefetch: (v: any) => void = () => {};
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      rpc: vi
        .fn()
        // initial load resolves immediately
        .mockResolvedValueOnce({ data: [row("a", "admin")], error: null })
        // refetch is held open so we can observe the in-between state
        .mockImplementationOnce(() => new Promise((res) => { resolveRefetch = res; })),
    } as any as SupabaseClient;

    const { result } = renderHook(() => useVaultUsers(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.loading).toBe(false);

    // Trigger a background refetch.
    act(() => { result.current.refetch(); });

    // While the refetch is in flight, the prior rows must remain and loading
    // must stay false (no blank-table flash).
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.user_id).toBe("a");

    // Let the refetch land with new rows.
    await act(async () => {
      resolveRefetch({ data: [row("a", "admin"), row("b", "editor")], error: null });
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.loading).toBe(false);
  });
});
