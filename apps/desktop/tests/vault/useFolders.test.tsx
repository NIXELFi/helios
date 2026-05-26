import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useFolders } from "../../src/modules/vault/data/useFolders";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(filterAssertion: (col: string, val: any) => void, rows: any[]): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: (col: string, val: any) => {
          filterAssertion(col, val);
          return {
            order: (_orderCol: string, _opts: { ascending: boolean }) => ({
              range: (_from: number, _to: number) =>
                Promise.resolve({ data: rows, error: null }),
            }),
          };
        },
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useFolders", () => {
  it("filters folders by vault_id", async () => {
    let observed: { col: string; val: any } | null = null;
    const c = mockClient((col, val) => { observed = { col, val }; }, [
      { id: "f1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "2026-01-01" },
    ]);
    const { result } = renderHook(() => useFolders("v1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed).toEqual({ col: "vault_id", val: "v1" });
    expect(result.current.data?.length).toBe(1);
  });

  it("returns null data while vault_id is undefined (no fetch)", () => {
    let called = false;
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => {
        called = true;
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      },
    } as any;
    const { result } = renderHook(() => useFolders(undefined), { wrapper: wrap(c) });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(called).toBe(false);
  });
});
