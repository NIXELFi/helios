import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useSetRevision } from "../../src/modules/vault/data/useSetRevision";

let rpcArgs: { name: string; args: any } | null = null;
function mockClient(opts: { error?: any } = {}): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => {
      rpcArgs = { name, args };
      return Promise.resolve({
        data: opts.error ? null : { id: "ver-1", file_id: "f1", version_num: 2, revision: 3, sha256: "x", size_bytes: 1, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" },
        error: opts.error ?? null,
      });
    },
  } as any;
}
const wrap = (client: SupabaseClient) => ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
);

describe("useSetRevision", () => {
  beforeEach(() => { rpcArgs = null; });

  it("calls pdm_set_revision with the file id and a null revision (auto) by default", async () => {
    const { result } = renderHook(() => useSetRevision(), { wrapper: wrap(mockClient()) });
    const ver = await result.current.run("f1" as any);
    expect(rpcArgs?.name).toBe("pdm_set_revision");
    expect(rpcArgs?.args).toEqual({ p_file_id: "f1", p_revision: null });
    expect(ver?.revision).toBe(3);
  });

  it("passes an explicit revision when provided", async () => {
    const { result } = renderHook(() => useSetRevision(), { wrapper: wrap(mockClient()) });
    await result.current.run("f1" as any, 7);
    expect(rpcArgs?.args).toEqual({ p_file_id: "f1", p_revision: 7 });
  });

  it("surfaces an error and returns null on failure", async () => {
    const { result } = renderHook(() => useSetRevision(), { wrapper: wrap(mockClient({ error: { message: "editor role required" } })) });
    const ver = await result.current.run("f1" as any);
    expect(ver).toBeNull();
    await waitFor(() => expect(result.current.error?.message ?? "").toMatch(/editor role required/i));
  });
});
