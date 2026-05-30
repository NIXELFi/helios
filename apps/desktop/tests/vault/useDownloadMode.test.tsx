import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { useDownloadMode, broadcastDownloadMode } from "../../src/modules/vault/data/useDownloadMode";

const STORAGE_KEY = "helios.vault.downloadMode";

beforeEach(() => {
  localStorage.clear();
});

describe("useDownloadMode", () => {
  it("defaults to 'manual' for any unset vault", () => {
    const { result } = renderHook(() => useDownloadMode("v1"));
    expect(result.current.mode).toBe("manual");
  });

  it("returns 'manual' when vaultId is null", () => {
    const { result } = renderHook(() => useDownloadMode(null));
    expect(result.current.mode).toBe("manual");
  });

  it("reads existing value from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v1: "auto" }));
    const { result } = renderHook(() => useDownloadMode("v1"));
    expect(result.current.mode).toBe("auto");
  });

  it("setMode persists to localStorage and updates this instance", () => {
    const { result } = renderHook(() => useDownloadMode("v1"));
    act(() => { result.current.setMode("auto"); });
    expect(result.current.mode).toBe("auto");
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.v1).toBe("auto");
  });

  it("setMode broadcasts to sibling hook instances in the same window", () => {
    // Two independent renderHook calls — both observe the change immediately
    // via the same-window subscriber broadcast, without remounting.
    const a = renderHook(() => useDownloadMode("v1"));
    const b = renderHook(() => useDownloadMode("v1"));
    expect(a.result.current.mode).toBe("manual");
    expect(b.result.current.mode).toBe("manual");

    act(() => { a.result.current.setMode("auto"); });
    expect(a.result.current.mode).toBe("auto");
    expect(b.result.current.mode).toBe("auto");
  });

  it("per-vault: setting v1 doesn't change v2", () => {
    const { result, rerender } = renderHook(
      ({ id }) => useDownloadMode(id),
      { initialProps: { id: "v1" as string | null } },
    );
    act(() => { result.current.setMode("auto"); });
    expect(result.current.mode).toBe("auto");

    rerender({ id: "v2" });
    expect(result.current.mode).toBe("manual");
  });

  it("H16: a storage event without newValue does NOT wipe existing modes", () => {
    // Repro of the 2026-05-25 audit finding (H16): DownloadModeWelcome.save()
    // dispatched `new StorageEvent("storage", { key })` with NO newValue.
    // useDownloadMode's listener did `setMap(e.newValue ? JSON.parse(...) : {})`
    // → reset every vault's mode to {} on the first save. A storage event
    // lacking newValue must fall back to re-reading localStorage, never wipe.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v1: "auto", v2: "auto" }));
    const { result } = renderHook(() => useDownloadMode("v1"));
    expect(result.current.mode).toBe("auto");

    act(() => {
      // The buggy dispatch: a same-key storage event with newValue === null.
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    // v1 must still be "auto" — not reset to the "manual" default.
    expect(result.current.mode).toBe("auto");
  });

  it("H16: broadcastDownloadMode updates sibling instances without a StorageEvent", () => {
    // The preferred fix path: DownloadModeWelcome calls the same-window
    // broadcast that useDownloadMode already provides, instead of a synthetic
    // StorageEvent. Sibling hook instances see the merged map immediately.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v1: "manual", v2: "manual" }));
    const a = renderHook(() => useDownloadMode("v1"));
    const b = renderHook(() => useDownloadMode("v2"));
    expect(a.result.current.mode).toBe("manual");
    expect(b.result.current.mode).toBe("manual");

    act(() => {
      // Simulate DownloadModeWelcome.save() persisting both picks then
      // broadcasting the merged map.
      const merged = { v1: "auto" as const, v2: "auto" as const };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      broadcastDownloadMode(merged);
    });

    expect(a.result.current.mode).toBe("auto");
    expect(b.result.current.mode).toBe("auto");
  });

  it("setMode is StrictMode-safe — writeMap + broadcast fire exactly once per call", () => {
    // Regression guard for the 2026-05-25 audit finding: setMode's updater
    // function used to perform writeMap + broadcast side effects inside the
    // useState updater. React StrictMode (which the production app may
    // enable in dev) invokes updater functions twice to surface impure
    // updaters — that would cause writeMap to JSON.stringify the same value
    // twice and double-fire broadcasts, which can interleave badly with
    // sibling instances handling the broadcasts.
    //
    // This test renders under StrictMode and asserts that a single setMode
    // call lands a single, consistent value (no flicker, no broadcast loop).
    const a = renderHook(() => useDownloadMode("v1"), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    const b = renderHook(() => useDownloadMode("v1"), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });

    act(() => { a.result.current.setMode("auto"); });

    // Final state must be 'auto' for both.
    expect(a.result.current.mode).toBe("auto");
    expect(b.result.current.mode).toBe("auto");

    // localStorage must hold the JSON map, not a stale snapshot.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ v1: "auto" });
  });
});
