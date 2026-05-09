import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useLocks } from "../../src/modules/vault/data/useLocks";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;

function mockClient(rows: any[], error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        is: (col: string, val: any) => {
          observed = { col, val };
          return Promise.resolve({ data: rows, error });
        },
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useLocks", () => {
  it("queries active locks with .is('released_at', null)", async () => {
    observed = null;
    const c = mockClient([
      { id: "l1", file_id: "f1", user_id: "u", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ]);
    const { result } = renderHook(() => useLocks(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed?.col).toBe("released_at");
    expect(observed?.val).toBeNull();
    expect(result.current.data?.length).toBe(1);
  });

  it("surfaces errors", async () => {
    observed = null;
    const c = mockClient([], { message: "RLS blocked" });
    const { result } = renderHook(() => useLocks(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("RLS blocked");
    expect(result.current.data).toBeNull();
  });
});
