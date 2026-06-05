import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useFolders } from "../../src/modules/vault/data/useFolders";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(
  filterAssertion: (col: string, val: any) => void,
  rows: any[],
  orderCalls?: Array<[string, { ascending: boolean }]>,
): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: (col: string, val: any) => {
          filterAssertion(col, val);
          // .order() is chainable so a unique tiebreaker can be appended;
          // it also exposes .range() to terminate the pagination chain.
          const makeChain = () => ({
            order: (orderCol: string, opts: { ascending: boolean }) => {
              orderCalls?.push([orderCol, opts]);
              return makeChain();
            },
            // Simulate a real paged source: the fixture is the first page;
            // subsequent .range() requests return empty so fetchAllRows
            // terminates (a fixed-rows mock would loop forever).
            range: (from: number, _to: number) =>
              Promise.resolve({ data: from === 0 ? rows : [], error: null }),
          });
          // useFolders adds .is("deleted_at", null) before the .order() chain
          // to exclude soft-deleted folders.
          return { is: () => makeChain() };
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

  it("orders by name THEN id (unique tiebreaker) for safe pagination", async () => {
    // `name` is not unique; without a PK tiebreaker rows can be skipped or
    // duplicated at .range() page boundaries (H10).
    const orderCalls: Array<[string, { ascending: boolean }]> = [];
    const c = mockClient(() => {}, [], orderCalls);
    const { result } = renderHook(() => useFolders("v1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(orderCalls).toEqual([
      ["name", { ascending: true }],
      ["id", { ascending: true }],
    ]);
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
