import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDeleteFolder } from "../../src/modules/vault/data/useDeleteFolder";
import { useRestoreFolder } from "../../src/modules/vault/data/useRestoreFolder";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let capturedArgs: any = null;

function mockClient(error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => {
      capturedArgs = { name, args };
      return Promise.resolve({ data: null, error });
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useDeleteFolder", () => {
  it("calls pdm_delete_folder RPC with p_folder_id and returns true on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useDeleteFolder(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fld1");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(capturedArgs).toEqual({ name: "pdm_delete_folder", args: { p_folder_id: "fld1" } });
    expect(returnValue).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces the RPC's message verbatim and returns false on error", async () => {
    // The SQL RAISE EXCEPTION copy (P0001) is the UI message; it must pass
    // through unchanged (minus the SQLSTATE suffix friendlyPgError strips).
    const c = mockClient({ code: "P0001", message: "folder contains 3 file(s) — only a vault admin can delete it (or empty it first)" });
    const { result } = renderHook(() => useDeleteFolder(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fld1");
    });
    expect(returnValue).toBe(false);
    expect(result.current.error?.message).toBe(
      "folder contains 3 file(s) — only a vault admin can delete it (or empty it first)",
    );
  });
});

describe("useRestoreFolder", () => {
  it("calls pdm_restore_folder RPC with p_folder_id and returns true on success", async () => {
    capturedArgs = null;
    const c = mockClient();
    const { result } = renderHook(() => useRestoreFolder(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fld1");
    });
    expect(capturedArgs).toEqual({ name: "pdm_restore_folder", args: { p_folder_id: "fld1" } });
    expect(returnValue).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces RPC errors and returns false", async () => {
    const c = mockClient({ code: "P0001", message: "only the person who deleted it (or an admin) can restore it" });
    const { result } = renderHook(() => useRestoreFolder(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fld1");
    });
    expect(returnValue).toBe(false);
    expect(result.current.error?.message).toBe("only the person who deleted it (or an admin) can restore it");
  });
});
