import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useInterval } from "../../src/modules/vault/data/useInterval";

describe("useInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls the callback every `delay` ms", () => {
    const cb = vi.fn();
    renderHook(() => useInterval(cb, 1000));
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("does not schedule when delay is null (disabled)", () => {
    const cb = vi.fn();
    renderHook(() => useInterval(cb, null));
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("always invokes the latest callback without resetting the timer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useInterval(cb, 1000), { initialProps: { cb: first } });
    vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ cb: second });
    vi.advanceTimersByTime(1000);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1); // not called again after swap
  });
});
