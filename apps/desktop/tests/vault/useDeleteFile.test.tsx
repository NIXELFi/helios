import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDeleteFile } from "../../src/modules/vault/data/useDeleteFile";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let capturedId: any = null;

function mockClient(error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "files") {
        return {
          delete: () => ({
            eq: (col: string, val: string) => {
              capturedId = val;
              return Promise.resolve({ data: null, error });
            },
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useDeleteFile", () => {
  it("calls files.delete().eq('id', file_id) and returns true on success", async () => {
    capturedId = null;
    const c = mockClient();
    const { result } = renderHook(() => useDeleteFile(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fi1");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedId).toBe("fi1");
    expect(returnValue).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces RLS rejection errors and returns false", async () => {
    const c = mockClient({ message: "permission denied", code: "42501" });
    const { result } = renderHook(() => useDeleteFile(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fi1");
    });
    expect(returnValue).toBe(false);
    expect(result.current.error?.message).toContain("permission denied");
  });
});
