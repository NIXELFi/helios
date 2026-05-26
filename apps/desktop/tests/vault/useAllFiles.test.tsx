import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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
              order: (_orderCol: string, _opts: { ascending: boolean }) => ({
                // Pagination via .range() — return all rows once; fetchAllRows
                // exits when a page is smaller than its page-size cap (1000).
                range: (_from: number, _to: number) =>
                  Promise.resolve({ data: files, error: null }),
              }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
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
});
