import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useVaultCursor } from "../../src/modules/vault/data/useVaultCursor";

// Mutable counts the fake client reports; tests mutate these between polls to
// simulate other people's changes landing in the vault. `errorTable` forces a
// probe failure to exercise the fallback path.
let counts: Record<string, number> = { files: 0, versions: 0, folders: 0, locks: 0 };
let errorTable: string | null = null;

function makeClient(): SupabaseClient {
  const from = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      then: (resolve: (r: { count: number | null; error: Error | null }) => void) =>
        errorTable === table
          ? resolve({ count: null, error: new Error("offline") })
          : resolve({ count: counts[table] ?? 0, error: null }),
    };
    return b;
  };
  return {
    from,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  } as unknown as SupabaseClient;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={makeClient()}>{children}</SupabaseAuthProvider>
);

// Flush the async probe (Promise.all of the count queries) under fake timers.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useVaultCursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    counts = { files: 10, versions: 5, folders: 2, locks: 0 };
    errorTable = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire onChange on the initial baseline probe", async () => {
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onChange once when a count changes between polls", async () => {
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper });
    await flush(); // baseline

    counts = { ...counts, versions: 6 }; // a teammate checked in
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire onChange when nothing changed", async () => {
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper });
    await flush(); // baseline

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // three idle polls
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not poll when disabled or when there is no vault", async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ id, enabled }: { id: string | undefined; enabled: boolean }) =>
        useVaultCursor(id, { intervalMs: 1000, onChange, enabled }),
      { wrapper, initialProps: { id: undefined, enabled: true } },
    );
    await flush();
    counts = { ...counts, versions: 99 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onChange).not.toHaveBeenCalled();

    rerender({ id: "v1", enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to a reconcile when the cheap probe fails", async () => {
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper });
    await flush(); // baseline (succeeds)

    errorTable = "files"; // probe now fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // A failed probe must not silently skip the safety net — reconcile instead.
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
