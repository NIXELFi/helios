/* Helios keeps looking for releases after the first check.
 *
 * It used to look once at startup, so a copy left open for a week never saw a
 * release and its auto-install never had anything to act on. The background
 * check runs on a timer, when the network comes back and on a release
 * broadcast; these pin that it finds updates, and that it is quiet about
 * everything else -- no "checking" flash, no flip to "offline" on one failure,
 * and never in the middle of an update. */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "5.9.3" }));

import { BACKGROUND_CHECK_MS, useUpdater } from "../use-updater";

const update = (version: string) => ({ version, currentVersion: "5.9.3", body: null, date: null, downloadAndInstall: vi.fn() });

describe("useUpdater background checks", () => {
  beforeEach(() => { vi.useFakeTimers(); check.mockReset(); });
  afterEach(() => vi.useRealTimers());

  async function started() {
    check.mockResolvedValueOnce(null);
    const r = renderHook(() => useUpdater());
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(r.result.current.state.kind).toBe("up_to_date");
    return r;
  }

  it("finds a release on the timer, without anybody clicking", async () => {
    const { result } = await started();
    check.mockResolvedValueOnce(update("5.9.4"));
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_MS); });
    expect(result.current.state.kind).toBe("available");
  });

  it("stays quiet: a failed background check leaves 'up to date' standing", async () => {
    const { result } = await started();
    const seen: string[] = [];
    check.mockRejectedValueOnce(new Error("dns"));
    await act(async () => {
      result.current.backgroundCheck();
      seen.push(result.current.state.kind);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seen).not.toContain("checking");
    expect(result.current.state.kind).toBe("up_to_date");
  });

  it("checks when the network comes back", async () => {
    const { result } = await started();
    check.mockResolvedValueOnce(update("5.9.4"));
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.state.kind).toBe("available");
  });

  it("never interrupts an update that is already on the table", async () => {
    const { result } = await started();
    check.mockResolvedValueOnce(update("5.9.4"));
    await act(async () => { result.current.backgroundCheck(); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.state.kind).toBe("available");
    const calls = check.mock.calls.length;
    await act(async () => { result.current.backgroundCheck(); await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_MS * 2); });
    expect(check.mock.calls.length).toBe(calls);
    expect(result.current.state.kind).toBe("available");
  });
});
