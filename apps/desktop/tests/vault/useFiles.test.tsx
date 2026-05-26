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
            return {
              order: (_orderCol: string, _opts: { ascending: boolean }) => ({
                range: (_from: number, _to: number) =>
                  Promise.resolve({ data: rows, error }),
              }),
            };
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
