import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useAuthLoading } from "@helios/auth";
import { useAcquireLock } from "../../src/modules/vault/data/useAcquireLock";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;

function mockClient(returnRow: any, error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
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

describe("useAcquireLock", () => {
  it("inserts a lock row with file_id + the current user id", async () => {
    observed = null;
    const c = mockClient({
      id: "lock1",
      file_id: "f1",
      user_id: "u1",
      acquired_at: "x",
      released_at: null,
      force_released_by: null,
    });
    const { result } = renderHook(
      () => ({ hook: useAcquireLock(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => {
      await result.current.hook.run("f1");
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));
    expect(observed).toEqual({ file_id: "f1", user_id: "u1" });
    expect(result.current.hook.result?.id).toBe("lock1");
    expect(result.current.hook.error).toBeNull();
  });

  it("surfaces RLS errors as a friendly permission message", async () => {
    const c = mockClient(null, { message: "permission denied", code: "42501" });
    const { result } = renderHook(
      () => ({ hook: useAcquireLock(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    // Wait for auth to resolve so user is set
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => {
      await result.current.hook.run("f1");
    });
    expect(result.current.hook.error?.message).toMatch(/permission denied/i);
    expect(result.current.hook.error?.message).toMatch(/lock/i);
  });

  it("surfaces a 23505 unique-violation as 'already checked out'", async () => {
    // Regression guard for the 2026-05-25 audit fix: a duplicate lock
    // attempt (already checked out by self or another user) used to surface
    // the raw Postgres "duplicate key value violates unique constraint" SQL
    // error. friendlyPgError turns it into a human-readable string.
    const c = mockClient(null, { message: "duplicate key value violates unique constraint", code: "23505" });
    const { result } = renderHook(
      () => ({ hook: useAcquireLock(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => { await result.current.hook.run("f1"); });
    expect(result.current.hook.error?.message).toMatch(/already checked out/i);
  });
});
