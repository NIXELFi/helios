import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useCreateFolder } from "../../src/modules/vault/data/useCreateFolder";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// useCreateFolder calls the pdm_create_folder resurrect-or-create RPC
// (20260721000000) rather than a direct INSERT, so a recycle-bin tombstone
// with the same name no longer bricks the create with a unique-violation.

let observed: { name: string; args: any } | null = null;

function mockClient(result: any, error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "admin1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => {
      observed = { name, args };
      return Promise.resolve({ data: result, error });
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useCreateFolder", () => {
  it("calls pdm_create_folder with vault_id, name, and optional parent_id", async () => {
    observed = null;
    const folderRow = {
      id: "folder1",
      vault_id: "vault1",
      parent_id: null,
      name: "Suspension",
      created_at: "2026-01-01",
    };
    const c = mockClient({ folder: folderRow, created: true, resurrected: false });
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrap(c) });
    let returned: any;
    await act(async () => {
      returned = await result.current.run("vault1", "Suspension", null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed).toEqual({
      name: "pdm_create_folder",
      args: { p_vault_id: "vault1", p_parent_id: null, p_name: "Suspension" },
    });
    expect(returned?.id).toBe("folder1");
    expect(result.current.error).toBeNull();
  });

  it("returns the folder row when the RPC resurrected a recycle-bin tombstone", async () => {
    const revived = { id: "old-folder", vault_id: "vault1", parent_id: null, name: "Aero", created_at: "x" };
    const c = mockClient({ folder: revived, created: false, resurrected: true });
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrap(c) });
    let returned: any;
    await act(async () => {
      returned = await result.current.run("vault1", "Aero");
    });
    expect(returned?.id).toBe("old-folder");
    expect(result.current.error).toBeNull();
  });

  it("surfaces RPC authorization errors", async () => {
    const c = mockClient(null, { message: "editor or admin role required to create folders" });
    const { result } = renderHook(() => useCreateFolder(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("vault1", "Brakes");
    });
    expect(result.current.error?.message).toContain("editor or admin role required");
  });
});
