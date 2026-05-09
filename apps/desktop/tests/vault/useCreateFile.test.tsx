import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useCreateFile } from "../../src/modules/vault/data/useCreateFile";
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

describe("useCreateFile", () => {
  it("inserts a file row with vault_id, folder_id, and name", async () => {
    observed = null;
    const fileRow = {
      id: "file1",
      vault_id: "vault1",
      folder_id: "folder1",
      name: "suspension.mcd",
      latest_version_id: null,
      created_at: "2026-01-01",
    };
    const c = mockClient(fileRow);
    const { result } = renderHook(() => useCreateFile(), { wrapper: wrap(c) });
    let returned: any;
    await act(async () => {
      returned = await result.current.run("vault1", "folder1", "suspension.mcd");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed).toEqual({ vault_id: "vault1", folder_id: "folder1", name: "suspension.mcd" });
    expect(returned?.id).toBe("file1");
    expect(result.current.error).toBeNull();
  });

  it("surfaces RLS errors", async () => {
    const c = mockClient(null, { message: "permission denied" });
    const { result } = renderHook(() => useCreateFile(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("vault1", null, "engine.mcd");
    });
    expect(result.current.error?.message).toContain("permission denied");
  });
});
