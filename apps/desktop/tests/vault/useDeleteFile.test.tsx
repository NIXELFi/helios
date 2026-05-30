import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDeleteFile } from "../../src/modules/vault/data/useDeleteFile";
import * as lockEvents from "../../src/modules/vault/data/lock-events";
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

  it("surfaces RLS rejection errors via friendlyPgError and returns false", async () => {
    const c = mockClient({ message: "permission denied for table files", code: "42501" });
    const { result } = renderHook(() => useDeleteFile(), { wrapper: wrap(c) });
    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.run("fi1");
    });
    expect(returnValue).toBe(false);
    // friendlyPgError(err, "file") maps 42501 to a context-specific message,
    // not the raw SQLSTATE/table-leaking string.
    expect(result.current.error?.message).toMatch(/permission denied/i);
    expect(result.current.error?.message).not.toContain("table files");
  });

  it("broadcasts a lock change after a successful delete", async () => {
    const spy = vi.spyOn(lockEvents, "notifyLockChange");
    const c = mockClient();
    const { result } = renderHook(() => useDeleteFile(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("fi1");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does NOT broadcast a lock change when the delete fails", async () => {
    const spy = vi.spyOn(lockEvents, "notifyLockChange");
    const c = mockClient({ message: "permission denied", code: "42501" });
    const { result } = renderHook(() => useDeleteFile(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("fi1");
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
