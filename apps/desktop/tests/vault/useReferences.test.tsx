import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useContains, useWhereUsed } from "../../src/modules/vault/data/useReferences";

function mockClient(opts: { refs?: any[]; files?: any[]; versions?: any[] } = {}): SupabaseClient {
  const { refs = [], files = [], versions = [] } = opts;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, _v: string) => Promise.resolve({ data: table === "refs" ? refs : [], error: null }),
        in: (_c: string, ids: string[]) => Promise.resolve({
          data: (table === "files" ? files : versions).filter((r: any) => ids.includes(r.id)),
          error: null,
        }),
      }),
    }),
  } as any;
}
const wrap = (client: SupabaseClient) => ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
);

describe("useContains", () => {
  it("lists child refs of a version, resolving file names", async () => {
    const refs = [{ parent_version_id: "pv", child_path_hint: "..\\frame.sldprt", child_file_id: "cf1", child_version_id: "cv1" }];
    const files = [{ id: "cf1", name: "frame.sldprt" }];
    const { result } = renderHook(() => useContains("pv" as any), { wrapper: wrap(mockClient({ refs, files })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].childName).toBe("frame.sldprt");
    expect(result.current.data?.[0].resolved).toBe(true);
  });

  it("marks an unresolved hint and falls back to its basename", async () => {
    const refs = [{ parent_version_id: "pv", child_path_hint: "..\\ghost.sldprt", child_file_id: null, child_version_id: null }];
    const { result } = renderHook(() => useContains("pv" as any), { wrapper: wrap(mockClient({ refs })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].resolved).toBe(false);
    expect(result.current.data?.[0].childName).toBe("ghost.sldprt");
  });

  it("returns null when no version is selected", () => {
    const { result } = renderHook(() => useContains(null), { wrapper: wrap(mockClient()) });
    expect(result.current.data).toBeNull();
  });
});

describe("useWhereUsed", () => {
  it("lists parent files that reference a file", async () => {
    const refs = [{ parent_version_id: "pv1", child_file_id: "cf1" }];
    const versions = [{ id: "pv1", file_id: "pf1" }];
    const files = [{ id: "pf1", name: "asm.sldasm" }];
    const { result } = renderHook(() => useWhereUsed("cf1" as any), { wrapper: wrap(mockClient({ refs, versions, files })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].parentName).toBe("asm.sldasm");
  });

  it("returns an empty list when nothing references the file", async () => {
    const { result } = renderHook(() => useWhereUsed("cf1" as any), { wrapper: wrap(mockClient({ refs: [] })) });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });
});
