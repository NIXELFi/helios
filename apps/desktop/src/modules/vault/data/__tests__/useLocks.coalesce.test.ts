// useLocks refetch coalescing (2026-11-16): the first request in a burst
// refetches AT ONCE (a fresh checkout must not wait — auto-sync would flip the
// new draft read-only meanwhile); the rest of the burst shares ONE follow-up.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let pulls = 0;
const client = {
  from: () => {
    const q: any = {
      select: () => q, is: () => q, order: () => q,
      range: async () => { pulls++; return { data: [], error: null }; },
    };
    return q;
  },
};
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => client }));

import { useLocks, LOCKS_COALESCE_MS } from "../useLocks";

beforeEach(() => { vi.useFakeTimers(); pulls = 0; });
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe("useLocks refetch coalescing", () => {
  it("refetches immediately when idle, then folds a burst into one follow-up", async () => {
    const { result } = renderHook(() => useLocks());
    await settle();
    expect(pulls).toBe(1); // initial load
    act(() => result.current.refetch());
    await settle();
    expect(pulls).toBe(2); // leading edge — no wait
    act(() => { result.current.refetch(); result.current.refetch(); result.current.refetch(); });
    await settle();
    expect(pulls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCKS_COALESCE_MS + 5); });
    expect(pulls).toBe(3); // one trailing pull for the burst
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCKS_COALESCE_MS * 4); });
    expect(pulls).toBe(3);
  });
});
