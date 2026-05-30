import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useUser } from "@helios/auth";
import { useCreateFile } from "../../src/modules/vault/data/useCreateFile";
import { subscribeLockChanges } from "../../src/modules/vault/data/lock-events";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;
let lockInsert: any = null;

function mockClient(returnRow: any, error: any = null, lockError: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "admin1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "locks") {
        // Auto-checkout inserts a lock row; awaited directly (no .select()).
        return {
          insert: (row: any) => {
            lockInsert = row;
            return Promise.resolve({ data: null, error: lockError });
          },
        };
      }
      return {
        insert: (row: any) => {
          observed = row;
          return {
            select: () => ({
              single: () => Promise.resolve({ data: returnRow, error }),
            }),
          };
        },
      };
    },
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

  it("auto-checks-out the new file to its creator (real-vault default) and broadcasts the lock change", async () => {
    observed = null;
    lockInsert = null;
    let notified = 0;
    const unsub = subscribeLockChanges(() => { notified++; });
    const fileRow = { id: "file1", vault_id: "vault1", folder_id: null, name: "new.mcd", latest_version_id: null, created_at: "x" };
    const c = mockClient(fileRow);
    const { result } = renderHook(
      () => ({ hook: useCreateFile(), user: useUser() }),
      { wrapper: wrap(c) },
    );
    // Wait for the session to resolve so the hook sees the current user
    // (auto-checkout needs user.id).
    await waitFor(() => expect(result.current.user).not.toBeNull());
    await act(async () => {
      await result.current.hook.run("vault1", null, "new.mcd");
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));
    unsub();
    // A lock row was inserted for the new file id + the current user.
    expect(lockInsert).toEqual({ file_id: "file1", user_id: "admin1" });
    expect(notified).toBe(1);
  });

  it("does not attempt auto-checkout when the file create fails", async () => {
    observed = null;
    lockInsert = null;
    const c = mockClient(null, { message: "permission denied" });
    const { result } = renderHook(() => useCreateFile(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("vault1", null, "x.mcd");
    });
    expect(lockInsert).toBeNull();
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
