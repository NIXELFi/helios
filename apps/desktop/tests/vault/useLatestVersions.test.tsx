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
                  // Honour .range(from,to) so fetchAllRows sees a partial page
                  // and terminates — its runaway guard (H11) trips otherwise.
                  range: (from: number, to: number) =>
                    Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
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

// A client whose versions query never resolves — used to hold the hook in its
// loading state so we can test the empty-fileIds early return mid-flight.
function makeClientNeverResolves(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation(() => ({
      select: () => ({
        in: () => ({
          order: () => ({
            order: () => ({
              range: () => new Promise<never>(() => {}),
            }),
          }),
        }),
      }),
    })),
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

  it("clears loading when fileIds empties while a fetch is still in flight (V19)", async () => {
    // Repro of the 2026-05-29 audit V19: a fetch is in flight (loading=true,
    // never resolves in this test), then fileIds empties (folder deselected).
    // The empty early-return must reset loading→false and error→null so the
    // spinner doesn't stick forever. Before the fix it returned early without
    // touching loading, leaving it stuck at true.
    const client = makeClientNeverResolves();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useLatestVersions(ids),
      { wrapper: wrap(client), initialProps: { ids: ["f1"] } },
    );
    // The in-flight fetch sets loading=true and never settles.
    await waitFor(() => expect(result.current.loading).toBe(true));
    // Now empty the id set mid-flight.
    rerender({ ids: [] });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data.size).toBe(0);
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
