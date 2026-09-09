import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useThrottledFocus } from "../use-throttled-focus";

function focus() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useThrottledFocus", () => {
  it("runs the handler on the first focus", () => {
    const handler = vi.fn();
    renderHook(() => useThrottledFocus(handler, 15_000));
    focus();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores a second focus inside the interval and runs again after it", () => {
    const handler = vi.fn();
    renderHook(() => useThrottledFocus(handler, 15_000));
    focus();
    act(() => void vi.advanceTimersByTime(5_000));
    focus();
    expect(handler).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10_001));
    focus();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled, and works once enabled", () => {
    const handler = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useThrottledFocus(handler, 15_000, enabled),
      { initialProps: { enabled: false } },
    );
    focus();
    expect(handler).not.toHaveBeenCalled();
    rerender({ enabled: true });
    focus();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("calls the latest handler without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: () => void }) => useThrottledFocus(handler, 0),
      { initialProps: { handler: first } },
    );
    rerender({ handler: second });
    focus();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useThrottledFocus(handler, 15_000));
    unmount();
    focus();
    expect(handler).not.toHaveBeenCalled();
  });
});
