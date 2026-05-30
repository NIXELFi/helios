import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useFiles } from "../../src/modules/vault/data/useFiles";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(
  tableAssertion: (table: string) => void,
  filterAssertion: (col: string, val: any) => void,
  rows: any[],
  error: any = null,
  orderCalls?: Array<[string, { ascending: boolean }]>,
): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      tableAssertion(table);
      return {
        select: () => ({
          eq: (col: string, val: any) => {
            filterAssertion(col, val);
            // .order() is chainable so a unique tiebreaker can be appended;
            // it also exposes .range() so pagination terminates the chain.
            const makeChain = () => ({
              order: (orderCol: string, opts: { ascending: boolean }) => {
                orderCalls?.push([orderCol, opts]);
                return makeChain();
              },
              // Simulate a real paged source: the fixture is the first page;
              // subsequent .range() requests return empty so fetchAllRows
              // terminates (a fixed-rows mock would loop forever).
              range: (from: number, _to: number) =>
                Promise.resolve({ data: from === 0 ? rows : [], error }),
            });
            return makeChain();
          },
        }),
      };
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useFiles", () => {
  it("queries from('files').select('*').eq('folder_id', folderId)", async () => {
    let observedTable: string | null = null;
    let observed: { col: string; val: any } | null = null;
    const c = mockClient(
      (t) => { observedTable = t; },
      (col, val) => { observed = { col, val }; },
      [
        { id: "fi1", vault_id: "v1", folder_id: "f1", name: "frame.sldprt", latest_version_id: null, created_at: "2026-01-01" },
      ],
    );
    const { result } = renderHook(() => useFiles("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observedTable).toBe("files");
    expect(observed).toEqual({ col: "folder_id", val: "f1" });
    expect(result.current.data?.length).toBe(1);
  });

  it("orders by name THEN id (unique tiebreaker) for safe pagination", async () => {
    // `name` is not unique; without a PK tiebreaker rows can be skipped or
    // duplicated at .range() page boundaries (H10). The id tiebreaker makes
    // the total order deterministic across pages.
    const orderCalls: Array<[string, { ascending: boolean }]> = [];
    const c = mockClient(() => {}, () => {}, [], null, orderCalls);
    const { result } = renderHook(() => useFiles("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(orderCalls).toEqual([
      ["name", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("returns null data while folder_id is undefined (no fetch)", () => {
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
    const { result } = renderHook(() => useFiles(undefined), { wrapper: wrap(c) });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(called).toBe(false);
  });

  it("surfaces errors", async () => {
    const c = mockClient(
      () => {},
      () => {},
      [],
      new Error("permission denied"),
    );
    const { result } = renderHook(() => useFiles("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("permission denied");
  });
});
