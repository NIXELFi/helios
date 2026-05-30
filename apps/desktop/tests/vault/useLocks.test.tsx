import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useLocks } from "../../src/modules/vault/data/useLocks";
import { notifyLockChange } from "../../src/modules/vault/data/lock-events";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;

function mockClient(rows: any[], error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        is: (col: string, val: any) => {
          observed = { col, val };
          return {
            order: (_orderCol: string, _opts: { ascending: boolean }) => ({
              // Pagination via .range() — return all rows once; fetchAllRows
              // exits when the page is smaller than its cap.
              range: (from: number, to: number) =>
                Promise.resolve({ data: rows.slice(from, to + 1), error }),
            }),
          };
        },
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useLocks", () => {
  it("queries active locks with .is('released_at', null)", async () => {
    observed = null;
    const c = mockClient([
      { id: "l1", file_id: "f1", user_id: "u", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ]);
    const { result } = renderHook(() => useLocks(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed?.col).toBe("released_at");
    expect(observed?.val).toBeNull();
    expect(result.current.data?.length).toBe(1);
  });

  it("surfaces errors", async () => {
    observed = null;
    const c = mockClient([], { message: "RLS blocked" });
    const { result } = renderHook(() => useLocks(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("RLS blocked");
    expect(result.current.data).toBeNull();
  });

  it("refetches when notifyLockChange() is broadcast", async () => {
    // Regression guard for the 2026-05-25 audit fix: lock-mutation hooks
    // (useAcquireLock / useReleaseLock / useForceUnlock) broadcast via
    // notifyLockChange after a successful RPC. useLocks must subscribe and
    // refetch immediately, closing the window where the local cache shows
    // a stale lock until realtime fires.
    let callCount = 0;
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => ({
        select: () => ({
          is: () => ({
            order: () => ({
              range: () => {
                callCount++;
                return Promise.resolve({ data: [], error: null });
              },
            }),
          }),
        }),
      }),
    } as any;
    const { result } = renderHook(() => useLocks(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(callCount).toBe(1);

    // Simulate a lock mutation succeeding.
    act(() => { notifyLockChange(); });
    await waitFor(() => expect(callCount).toBe(2));
  });
});
