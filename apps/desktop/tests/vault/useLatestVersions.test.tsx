import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useLatestVersions } from "../../src/modules/vault/data/useLatestVersions";

function makeClient(rows: any[]): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "versions") {
        return {
          select: () => ({
            in: () => ({
              // Two .order() calls: (version_num desc, file_id asc) — the
              // second is the pagination-stability tiebreaker added in the
              // 2026-05-25 audit fix.
              order: () => ({
                order: () => ({
                  // The hook chunks ids into batches and paginates each batch.
                  // Returning all rows on the first .range() exits the loop.
                  range: (_from: number, _to: number) =>
                    Promise.resolve({ data: rows, error: null }),
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

function wrap(client: SupabaseClient) {
  return ({ children }: { children: ReactNode }) => (
    <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
  );
}

describe("useLatestVersions", () => {
  it("returns empty map when no file ids provided", () => {
    const client = makeClient([]);
    const { result } = renderHook(() => useLatestVersions([]), { wrapper: wrap(client) });
    expect(result.current.data.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it("returns latest version per file from a multi-file, multi-version response", async () => {
    const rows = [
      // file_id "f1" has two versions; v2 (version_num 2) should win
      { id: "v2", file_id: "f1", version_num: 2, sha256: "sha-v2", size_bytes: 10, author_id: "u", comment: null, parent_version_id: "v1", created_at: "x" },
      { id: "v1", file_id: "f1", version_num: 1, sha256: "sha-v1", size_bytes: 5, author_id: "u", comment: null, parent_version_id: null, created_at: "x" },
      // file_id "f2" has one version
      { id: "v3", file_id: "f2", version_num: 1, sha256: "sha-f2", size_bytes: 8, author_id: "u", comment: null, parent_version_id: null, created_at: "x" },
    ];
    const client = makeClient(rows);
    const { result } = renderHook(() => useLatestVersions(["f1", "f2"]), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.size).toBe(2);
    expect(result.current.data.get("f1")?.sha256).toBe("sha-v2");
    expect(result.current.data.get("f2")?.sha256).toBe("sha-f2");
  });
});
