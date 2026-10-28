import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCK_NOTIFY_DEBOUNCE_MS,
  LOCK_NOTIFY_MAX_WAIT_MS,
  notifyLockChange,
  resetLockEventsForTests,
  subscribeLockChanges,
} from "../../src/modules/vault/data/lock-events";

describe("notifyLockChange coalescing", () => {
  let cb: ReturnType<typeof vi.fn>;
  let unsub: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLockEventsForTests();
    cb = vi.fn();
    unsub = subscribeLockChanges(cb);
  });
  afterEach(() => {
    unsub();
    resetLockEventsForTests();
    vi.useRealTimers();
  });

  it("fires immediately on the leading edge", () => {
    notifyLockChange();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire again for a lone call once the quiet window passes", () => {
    notifyLockChange();
    vi.advanceTimersByTime(LOCK_NOTIFY_DEBOUNCE_MS * 4);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into the leading fire plus one trailing fire", () => {
    notifyLockChange();
    for (let i = 0; i < 300; i++) {
      vi.advanceTimersByTime(2); // a fast batch: well inside the debounce window
      notifyLockChange();
    }
    expect(cb).toHaveBeenCalledTimes(1); // trailing still deferred
    vi.advanceTimersByTime(LOCK_NOTIFY_DEBOUNCE_MS);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(LOCK_NOTIFY_DEBOUNCE_MS * 4);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("bounds a sustained burst with the max wait", () => {
    notifyLockChange(); // leading
    // A call every 100ms never lets the 250ms debounce elapse; the 1s cap must.
    for (let t = 0; t < LOCK_NOTIFY_MAX_WAIT_MS + 200; t += 100) {
      vi.advanceTimersByTime(100);
      notifyLockChange();
    }
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cb.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("fires on the leading edge again after the burst has settled", () => {
    notifyLockChange();
    notifyLockChange();
    vi.advanceTimersByTime(LOCK_NOTIFY_DEBOUNCE_MS * 4);
    expect(cb).toHaveBeenCalledTimes(2);
    notifyLockChange();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("an unsubscribed listener is not called by the trailing fire", () => {
    notifyLockChange();
    notifyLockChange();
    unsub();
    vi.advanceTimersByTime(LOCK_NOTIFY_DEBOUNCE_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
