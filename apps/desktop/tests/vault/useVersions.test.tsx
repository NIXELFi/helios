import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVersions } from "../../src/modules/vault/data/useVersions";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;
let rangeCalls: Array<{ from: number; to: number }> = [];

function mockClient(
  pages: any[][] | any[],
  error: any = null,
): SupabaseClient {
  // `pages` may be a single flat array (single-page) or an array of arrays
  // (one per .range() call). fetchAllRows stops when a page < PAGE_SIZE.
  const normalized: any[][] = Array.isArray(pages[0]) ? (pages as any[][]) : [pages as any[]];
  let pageIdx = 0;
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
            return {
              range: (from: number, to: number) => {
                rangeCalls.push({ from, to });
                if (error) return Promise.resolve({ data: null, error });
                const page = normalized[pageIdx++] ?? [];
                return Promise.resolve({ data: page, error: null });
              },
            };
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
    rangeCalls = [];
    const c = mockClient([
      { id: "v1", file_id: "f1", version_num: 1, sha256: "x", size_bytes: 1, author_id: "u", comment: null, parent_version_id: null, created_at: "x" },
    ]);
    const { result } = renderHook(() => useVersions("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed?.eqCol).toBe("file_id");
    expect(observed?.eqVal).toBe("f1");
    expect(observed?.orderCol).toBe("version_num");
    expect(observed?.ascending).toBe(false);
    expect(rangeCalls[0]).toEqual({ from: 0, to: 999 });
  });

  it("returns null data while file_id is undefined (no fetch)", () => {
    observed = null;
    rangeCalls = [];
    const c = mockClient([]);
    const { result } = renderHook(() => useVersions(undefined), { wrapper: wrap(c) });
    expect(result.current.data).toBeNull();
    expect(observed).toBeNull();
    expect(rangeCalls).toHaveLength(0);
  });

  it("surfaces errors", async () => {
    observed = null;
    rangeCalls = [];
    const c = mockClient([], { message: "RLS blocked" });
    const { result } = renderHook(() => useVersions("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("RLS blocked");
  });

  it("resets data to null when file_id changes so the previous file's versions don't linger (V13)", async () => {
    // Repro of the 2026-05-29 audit V13: selecting file B should show loading,
    // not file A's stale version list, while B's query is in flight. The hook
    // must reset data→null at the start of each fetch effect.
    observed = null;
    rangeCalls = [];
    // file A resolves immediately; file B's query never resolves (stays in
    // flight) so we can observe the in-between state.
    const aRows = [
      { id: "a1", file_id: "fA", version_num: 1, sha256: "x", size_bytes: 1, author_id: null, comment: null, parent_version_id: null, created_at: "x" },
    ];
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => ({
        select: () => ({
          eq: (_col: string, val: any) => ({
            order: () => ({
              // Honour the .range(from,to) so fetchAllRows sees a partial page
              // and terminates; a real paginated query slices the same way.
              range: (from: number, to: number) =>
                val === "fA"
                  ? Promise.resolve({ data: aRows.slice(from, to + 1), error: null })
                  : new Promise<never>(() => {}),
            }),
          }),
        }),
      }),
    } as any as SupabaseClient;

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useVersions(id),
      { wrapper: wrap(client), initialProps: { id: "fA" } },
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    // Switch to file B — its query never resolves.
    rerender({ id: "fB" });
    // Data must immediately reset to null (loading) rather than show A's rows.
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("paginates past the PostgREST 1000-row cap", async () => {
    // Two pages: first returns 1000 rows (signals "maybe more"), second returns
    // 500 (a partial page, so fetchAllRows stops). Without pagination the hook
    // would silently truncate at 1000 — which is the bug this test guards.
    observed = null;
    rangeCalls = [];
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `v${i}`,
      file_id: "f1",
      version_num: 1500 - i,
      sha256: "x",
      size_bytes: 1,
      author_id: null,
      comment: null,
      parent_version_id: null,
      created_at: "x",
    }));
    const page2 = Array.from({ length: 500 }, (_, i) => ({
      id: `v${1000 + i}`,
      file_id: "f1",
      version_num: 500 - i,
      sha256: "x",
      size_bytes: 1,
      author_id: null,
      comment: null,
      parent_version_id: null,
      created_at: "x",
    }));
    const c = mockClient([page1, page2]);
    const { result } = renderHook(() => useVersions("f1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.data).not.toBeNull(), { timeout: 2000 });
    expect(result.current.data).toHaveLength(1500);
    expect(rangeCalls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
  });
});
