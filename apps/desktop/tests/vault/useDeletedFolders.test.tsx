import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDeletedFolders } from "../../src/modules/vault/data/useDeletedFolders";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let capturedTable: string | null = null;
let capturedNot: any[] | null = null;

/**
 * Chainable query-builder mock. useDeletedFolders paginates via fetchAllRows,
 * which calls `buildQuery().range(from,to)`; every intermediate filter/order
 * returns `this`, and `.range()` resolves with the rows.
 */
function mockClient(rows: any[], error: any = null): SupabaseClient {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    not: (...args: any[]) => {
      capturedNot = args;
      return builder;
    },
    order: () => builder,
    // Slice by (from,to) so fetchAllRows sees a short final page and stops.
    range: (from: number, to: number) =>
      Promise.resolve({ data: error ? null : rows.slice(from, to + 1), error }),
  };
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      capturedTable = table;
      return builder;
    },
  } as any;
}

function makeWrapper(client: SupabaseClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
  };
}

describe("useDeletedFolders", () => {
  it("queries the folders table filtered to soft-deleted rows and returns them", async () => {
    capturedTable = null;
    capturedNot = null;
    const rows = [
      { id: "f1", vault_id: "v1", parent_id: null, name: "Old", created_at: "2026-01-01", deleted_at: "2026-02-01" },
    ];
    const { result } = renderHook(() => useDeletedFolders("v1"), {
      wrapper: makeWrapper(mockClient(rows)),
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedTable).toBe("folders");
    expect(capturedNot).toEqual(["deleted_at", "is", null]);
    expect(result.current.data).toEqual(rows);
    expect(result.current.error).toBeNull();
  });

  it("surfaces errors", async () => {
    const { result } = renderHook(() => useDeletedFolders("v1"), {
      wrapper: makeWrapper(mockClient([], { message: "RLS blocked" })),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("RLS blocked");
  });

  it("is idle with no vault id", async () => {
    const { result } = renderHook(() => useDeletedFolders(undefined), {
      wrapper: makeWrapper(mockClient([])),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });
});
