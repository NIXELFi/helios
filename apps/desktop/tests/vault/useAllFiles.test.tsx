import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useAllFiles } from "../../src/modules/vault/data/useAllFiles";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

const FILES = [
  { id: "fi1", vault_id: "v1", folder_id: null, name: "root.sldprt", latest_version_id: null, created_at: "x" },
  { id: "fi2", vault_id: "v1", folder_id: "f1", name: "sub.sldprt", latest_version_id: null, created_at: "x" },
];

function mockClient(files: any[] = FILES): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "files") {
        return {
          select: () => ({
            eq: (_col: string, _val: string) => ({
              // Soft-delete filter: .is("deleted_at", null) precedes .order().
              is: (_isCol: string, _isVal: any) => ({
                order: (_orderCol: string, _opts: { ascending: boolean }) => ({
                  // Pagination via .range() — return all rows once; fetchAllRows
                  // exits when a page is smaller than its page-size cap (1000).
                  range: (from: number, to: number) =>
                    Promise.resolve({ data: files.slice(from, to + 1), error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

type Chain = Array<[string, ...unknown[]]>;

/** Does this query chain carry a folder or id scope (i.e. is it one of the new
 *  targeted refreshes rather than the whole-catalog pull)? */
function isTargeted(chain: Chain): boolean {
  return chain.some(([m, col]) => (m === "in" && col === "id") || col === "folder_id");
}

/**
 * Records the filter chain of every `files` query so the targeted refreshes can
 * be asserted on shape (which is exactly where a wrong filter would silently
 * merge the wrong rows). A chain that carries a folder/id scope is answered
 * with `targeted`, everything else with `initial`. Note fetchAllRows builds a
 * FRESH query per page, so one logical read can appear as several chains.
 */
function trackingClient(initial: any[], targeted: any[]) {
  const chains: Chain[] = [];
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== "files") return { select: () => Promise.resolve({ data: [], error: null }) };
      const chain: Chain = [];
      chains.push(chain);
      const node: any = {
        select: (sel: string) => { chain.push(["select", sel]); return node; },
        eq: (c: string, v: unknown) => { chain.push(["eq", c, v]); return node; },
        is: (c: string, v: unknown) => { chain.push(["is", c, v]); return node; },
        in: (c: string, v: unknown) => { chain.push(["in", c, v]); return node; },
        order: (c: string) => { chain.push(["order", c]); return node; },
        range: (from: number, to: number) =>
          Promise.resolve({ data: (isTargeted(chain) ? targeted : initial).slice(from, to + 1), error: null }),
      };
      return node;
    }),
  } as any as SupabaseClient;
  return { client, chains, targetedChains: () => chains.filter(isTargeted) };
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useAllFiles", () => {
  it("returns null when vault_id is undefined", async () => {
    const c = mockClient();
    const { result } = renderHook(() => useAllFiles(undefined), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("returns all files for a given vault_id", async () => {
    const c = mockClient();
    const { result } = renderHook(() => useAllFiles("v1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].id).toBe("fi1");
    expect(result.current.data![1].id).toBe("fi2");
    expect(result.current.error).toBeNull();
  });

  it("refreshFolder re-reads ONE folder and merges it in (adds, updates, removes)", async () => {
    const initial = [
      { id: "a", vault_id: "v1", folder_id: "f1", name: "a.sldprt", latest_version_id: null, created_at: "x" },
      { id: "b", vault_id: "v1", folder_id: "f1", name: "b.sldprt", latest_version_id: null, created_at: "x" },
      { id: "z", vault_id: "v1", folder_id: "f2", name: "z.sldprt", latest_version_id: null, created_at: "x" },
    ];
    // f1 now holds a (renamed) and a new c; b is gone.
    const targeted = [
      { id: "a", vault_id: "v1", folder_id: "f1", name: "renamed.sldprt", latest_version_id: null, created_at: "x" },
      { id: "c", vault_id: "v1", folder_id: "f1", name: "c.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const { client, targetedChains } = trackingClient(initial, targeted);
    const { result } = renderHook(() => useAllFiles("v1"), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(3));

    await act(async () => { result.current.refreshFolder("f1"); });
    await waitFor(() => expect(result.current.data!.map((f) => f.id)).toEqual(["a", "z", "c"]));
    expect(result.current.data![0]!.name).toBe("renamed.sldprt");

    // The scoped read must be vault + live + that folder, or it would merge the
    // wrong rows into the catalog.
    const scoped = targetedChains()[0]!;
    expect(scoped).toContainEqual(["eq", "vault_id", "v1"]);
    expect(scoped).toContainEqual(["is", "deleted_at", null]);
    expect(scoped).toContainEqual(["eq", "folder_id", "f1"]);
  });

  it("refreshFolder(null) scopes to the vault ROOT with folder_id is null", async () => {
    const initial = [
      { id: "r", vault_id: "v1", folder_id: null, name: "r.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const { client, targetedChains } = trackingClient(initial, initial);
    const { result } = renderHook(() => useAllFiles("v1"), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => { result.current.refreshFolder(null); });
    await waitFor(() => expect(targetedChains().length).toBeGreaterThan(0));
    expect(targetedChains()[0]!).toContainEqual(["is", "folder_id", null]);
  });

  it("refreshIds re-reads only the named files and never drops the others", async () => {
    const initial = [
      { id: "a", vault_id: "v1", folder_id: "f1", name: "a.sldprt", latest_version_id: "v-old", created_at: "x" },
      { id: "b", vault_id: "v1", folder_id: "f1", name: "b.sldprt", latest_version_id: null, created_at: "x" },
    ];
    // The server answers for `a` only — `b` staying put is the point: an id that
    // comes back empty is not evidence of a delete.
    const targeted = [
      { id: "a", vault_id: "v1", folder_id: "f1", name: "a.sldprt", latest_version_id: "v-new", created_at: "x" },
    ];
    const { client, targetedChains } = trackingClient(initial, targeted);
    const { result } = renderHook(() => useAllFiles("v1"), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    await act(async () => { result.current.refreshIds(["a", "b"]); });
    await waitFor(() => expect(result.current.data![0]!.latest_version_id).toBe("v-new"));
    expect(result.current.data!.map((f) => f.id)).toEqual(["a", "b"]);
    expect(targetedChains()[0]!).toContainEqual(["in", "id", ["a", "b"]]);
  });

  it("refreshIds with no ids does not hit the network at all", async () => {
    const { client, targetedChains } = trackingClient(FILES, FILES);
    const { result } = renderHook(() => useAllFiles("v1"), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    await act(async () => { result.current.refreshIds([]); });
    expect(targetedChains()).toHaveLength(0);
  });
});
