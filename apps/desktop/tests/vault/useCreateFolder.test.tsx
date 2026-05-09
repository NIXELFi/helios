import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useCreateFolder } from "../../src/modules/vault/data/useCreateFolder";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;

function mockClient(returnRow: any, error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "admin1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      insert: (row: any) => {
        observed = row;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: returnRow, error }),
          }),
        };
      },
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useCreateFolder", () => {
  it("inserts a folder with vault_id, name, and optional parent_id", async () => {
    observed = null;
    const folderRow = {
      id: "folder1",
      vault_id: "vault1",
      parent_id: null,
      name: "Suspension",
      created_at: "2026-01-01",
    };
    const c = mockClient(folderRow);
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrap(c) });
    let returned: any;
    await act(async () => {
      returned = await result.current.run("vault1", "Suspension", null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed).toEqual({ vault_id: "vault1", name: "Suspension", parent_id: null });
    expect(returned?.id).toBe("folder1");
    expect(result.current.error).toBeNull();
  });

  it("surfaces RLS errors", async () => {
    const c = mockClient(null, { message: "permission denied" });
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("vault1", "Brakes");
    });
    expect(result.current.error?.message).toContain("permission denied");
  });
});
