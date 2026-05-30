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

// Variant whose onAuthStateChange listener is captured so the test can flip
// the session to null mid-lifetime (simulating session expiry / sign-out).
function mockClientWithAuthControl(returnRow: any): {
  client: SupabaseClient;
  emitSession: (session: any) => void;
} {
  let listener: ((event: string, session: any) => void) | null = null;
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: (cb: (event: string, session: any) => void) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    from: () => ({
      insert: (row: any) => {
        observed = row;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: returnRow, error: null }),
          }),
        };
      },
    }),
  } as any;
  return { client, emitSession: (session) => listener?.("SIGNED_OUT", session) };
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

  it("clears a stale result on the no-user early return (V20)", async () => {
    // Repro of the 2026-05-29 audit V20: acquire succeeds (result set), then
    // the session expires and the user calls run() again. The !user branch
    // set an error but left the previous successful `result` in place, so hook
    // state lied about the latest attempt. It must also clear result→null.
    observed = null;
    const { client, emitSession } = mockClientWithAuthControl({
      id: "lock1",
      file_id: "f1",
      user_id: "u1",
      acquired_at: "x",
      released_at: null,
      force_released_by: null,
    });
    const { result } = renderHook(
      () => ({ hook: useAcquireLock(), authLoading: useAuthLoading() }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    // First acquire succeeds → result populated.
    await act(async () => { await result.current.hook.run("f1"); });
    await waitFor(() => expect(result.current.hook.result?.id).toBe("lock1"));

    // Session expires — user becomes null.
    act(() => { emitSession(null); });

    // Second attempt hits the !user early-return.
    let ret: unknown;
    await act(async () => { ret = await result.current.hook.run("f1"); });
    expect(ret).toBeNull();
    expect(result.current.hook.error?.message).toMatch(/session has expired/i);
    // The stale successful result must be cleared.
    expect(result.current.hook.result).toBeNull();
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
