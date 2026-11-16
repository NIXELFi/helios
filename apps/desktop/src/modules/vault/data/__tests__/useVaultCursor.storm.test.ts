/**
 * useVaultCursor — re-run storm guard (2026-11-16).
 *
 * Every re-run of the hook's effect fired an immediate probe. A flapping
 * dependency (a laptop waking onto a new network) produced 291 vault_cursor
 * RPCs in two seconds from one client. At most one probe may be in flight and
 * a catch-up probe within MIN_PROBE_GAP_MS of the last one is deferred.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const rpc = vi.fn(async () => ({
  data: [{ live_files: 1, versions: 1, live_folders: 1, active_locks: 0 }],
  error: null,
}));
const client = { rpc, from: () => { throw new Error("legacy path not expected"); } };
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => client }));

import { useVaultCursor, MIN_PROBE_GAP_MS, PROBE_TIMEOUT_MS } from "../useVaultCursor";

beforeEach(() => {
  vi.useFakeTimers();
  rpc.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useVaultCursor storm guard", () => {
  it("probes once for many rapid enabled flips", async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      (p: { enabled: boolean }) =>
        useVaultCursor("v1" as never, { intervalMs: 15_000, onChange, enabled: p.enabled }),
      { initialProps: { enabled: true } },
    );
    for (let i = 0; i < 100; i++) {
      rerender({ enabled: false });
      rerender({ enabled: true });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rpc).toHaveBeenCalledTimes(1);
    // ...and the deferred catch-up collapses to ONE trailing probe.
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS + 10); });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("defers (does not drop) a catch-up right after a probe", async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      (p: { enabled: boolean }) =>
        useVaultCursor("v1" as never, { intervalMs: 60_000, onChange, enabled: p.enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS + 10); });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("still catches up after a real hidden stretch", async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      (p: { enabled: boolean }) =>
        useVaultCursor("v1" as never, { intervalMs: 60_000, onChange, enabled: p.enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    rerender({ enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS + 1_000); });
    rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("a hung probe times out instead of silencing the poll", async () => {
    let hang = true;
    rpc.mockImplementation(async () => {
      if (hang) return new Promise(() => {}) as never;
      return { data: [{ live_files: 1, versions: 1, live_folders: 1, active_locks: 0 }], error: null };
    });
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1" as never, { intervalMs: 15_000, onChange, enabled: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rpc).toHaveBeenCalledTimes(1);
    hang = false;
    // The hung probe fails at the timeout (a full reconcile), then polling resumes.
    await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10); });
    expect(onChange).toHaveBeenCalledWith(null, null);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
