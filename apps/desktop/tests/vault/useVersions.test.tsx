import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVersions } from "../../src/modules/vault/data/useVersions";
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
        eq: (col: string, val: any) => ({
          order: (col2: string, opts: { ascending: boolean }) => {
            observed = { eqCol: col, eqVal: val, orderCol: col2, ascending: opts.ascending };
            return Promise.resolve({ data: rows, error });
          },
        }),
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useVersions", () => {
  it("filters by file_id and orders by version_num desc", async () => {
    observed = null;
    const c = mockClient([
      { id: "v1", file_id: "f1", version_num: 1, sha256: "x", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" },
    ]);
    const { result } = renderHook(() => useVersions("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed?.eqCol).toBe("file_id");
    expect(observed?.eqVal).toBe("f1");
    expect(observed?.orderCol).toBe("version_num");
    expect(observed?.ascending).toBe(false);
  });

  it("returns null data while file_id is undefined (no fetch)", () => {
    observed = null;
    const c = mockClient([]);
    const { result } = renderHook(() => useVersions(undefined), { wrapper: wrap(c) });
    expect(result.current.data).toBeNull();
    expect(observed).toBeNull();
  });

  it("surfaces errors", async () => {
    observed = null;
    const c = mockClient([], { message: "RLS blocked" });
    const { result } = renderHook(() => useVersions("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("RLS blocked");
  });
});
