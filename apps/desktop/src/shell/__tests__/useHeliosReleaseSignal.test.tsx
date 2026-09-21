/* Release broadcasts reach the updater: on a message, on a REconnect (a
 * machine that was offline when the release went out), not on the first
 * join, and never faster than the throttle allows. Also covers the sim's
 * listener, which is the same shape on its own channel. */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const simCheck = vi.fn(async (_reason: string) => {});
vi.mock("../../modules/sim/lib/simUpdater", () => ({
  requestSimUpdateCheck: (reason: string) => simCheck(reason),
}));

import {
  HELIOS_RELEASE_CHANNEL, HELIOS_RELEASE_EVENT, RELEASE_SIGNAL_MIN_INTERVAL_MS, useHeliosReleaseSignal,
} from "../useHeliosReleaseSignal";
import { SIM_RELEASE_CHANNEL, SIM_RELEASE_EVENT, useSimReleaseSignal } from "../../modules/sim/lib/useSimReleaseSignal";

/** A stand-in for supabase-js's channel: records handlers so a test can fire them. */
function fakeClient() {
  const channels: Record<string, { handlers: Record<string, () => void>; status?: (s: string) => void; removed: boolean }> = {};
  const client = {
    channel(name: string) {
      const ch = { handlers: {} as Record<string, () => void>, status: undefined as ((s: string) => void) | undefined, removed: false };
      channels[name] = ch;
      const api = {
        on(_type: string, filter: { event: string }, fn: () => void) { ch.handlers[filter.event] = fn; return api; },
        subscribe(fn: (s: string) => void) { ch.status = fn; return api; },
        _ch: ch,
      };
      return api;
    },
    removeChannel(api: { _ch: { removed: boolean } }) { api._ch.removed = true; },
  };
  return { client: client as never, channels };
}

describe("useHeliosReleaseSignal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks on a broadcast and on a reconnect, not on the first join", () => {
    const { client, channels } = fakeClient();
    const onRelease = vi.fn();
    const { unmount } = renderHook(() => useHeliosReleaseSignal(client, onRelease));
    const ch = channels[HELIOS_RELEASE_CHANNEL]!;
    act(() => ch.status!("SUBSCRIBED"));
    expect(onRelease).not.toHaveBeenCalled();
    act(() => ch.handlers[HELIOS_RELEASE_EVENT]!());
    expect(onRelease).toHaveBeenCalledTimes(1);
    // A reconnect inside the window is held, then acted on.
    act(() => ch.status!("SUBSCRIBED"));
    expect(onRelease).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(RELEASE_SIGNAL_MIN_INTERVAL_MS + 10); });
    expect(onRelease).toHaveBeenCalledTimes(2);
    unmount();
    expect(ch.removed).toBe(true);
  });

  it("collapses a flood of messages", () => {
    const { client, channels } = fakeClient();
    const onRelease = vi.fn();
    renderHook(() => useHeliosReleaseSignal(client, onRelease));
    const fire = channels[HELIOS_RELEASE_CHANNEL]!.handlers[HELIOS_RELEASE_EVENT]!;
    act(() => { for (let i = 0; i < 100; i++) fire(); });
    act(() => { vi.advanceTimersByTime(RELEASE_SIGNAL_MIN_INTERVAL_MS * 4); });
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a realtime client", () => {
    const onRelease = vi.fn();
    renderHook(() => useHeliosReleaseSignal(null, onRelease));
    expect(onRelease).not.toHaveBeenCalled();
  });
});

describe("useSimReleaseSignal", () => {
  beforeEach(() => { vi.useFakeTimers(); simCheck.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("checks at startup, on a timer, on a broadcast and on a reconnect", () => {
    const { client, channels } = fakeClient();
    renderHook(() => useSimReleaseSignal(client));
    expect(simCheck).toHaveBeenLastCalledWith("startup");
    const ch = channels[SIM_RELEASE_CHANNEL]!;
    act(() => ch.status!("SUBSCRIBED"));
    expect(simCheck).toHaveBeenCalledTimes(1);
    act(() => ch.handlers[SIM_RELEASE_EVENT]!());
    expect(simCheck).toHaveBeenLastCalledWith("signal");
    act(() => ch.status!("SUBSCRIBED"));
    expect(simCheck).toHaveBeenLastCalledWith("reconnect");
    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(simCheck).toHaveBeenLastCalledWith("timer");
  });

  it("still checks at startup when signed out", () => {
    renderHook(() => useSimReleaseSignal(null));
    expect(simCheck).toHaveBeenCalledWith("startup");
  });
});
