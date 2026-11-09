/* useUpdater records each hand-off to the installer, so a Helios that comes
 * back still on the old version knows the install didn't land (see
 * update-attempts.ts), and takes the record back when the hand-off never
 * happened. */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "6.7.0" }));

import { useUpdater } from "../use-updater";
import { failedInstallAttempts, recordInstallAttempt } from "../update-attempts";

const update = (downloadAndInstall: () => Promise<void>) => ({
  version: "6.7.1", currentVersion: "6.7.0", body: null, date: null, downloadAndInstall,
});

async function available(dl: () => Promise<void>) {
  check.mockResolvedValueOnce(update(dl));
  const r = renderHook(() => useUpdater());
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(r.result.current.state.kind).toBe("available");
  return r;
}

describe("useUpdater install attempts", () => {
  beforeEach(() => { vi.useFakeTimers(); check.mockReset(); });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it("records the attempt before handing off to the installer", async () => {
    let seenDuringInstall = -1;
    const { result } = await available(async () => {
      seenDuringInstall = failedInstallAttempts("6.7.1", "6.7.0");
    });
    await act(async () => { await result.current.installAndRelaunch(); });
    // On Windows the process exits inside downloadAndInstall, so the record
    // must already be there by then.
    expect(seenDuringInstall).toBe(1);
  });

  it("takes the record back when the download fails", async () => {
    const { result } = await available(async () => { throw new Error("signature mismatch"); });
    await act(async () => { await result.current.installAndRelaunch(); });
    expect(result.current.state.kind).toBe("offline");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(0);
  });

  it("forgets the record once the update has landed", async () => {
    recordInstallAttempt("6.7.0", "6.6.2"); // the update we're now running
    check.mockResolvedValueOnce(null);
    const r = renderHook(() => useUpdater());
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(r.result.current.state.kind).toBe("up_to_date");
    expect(localStorage.getItem("helios.updater.installAttempts")).toBeNull();
  });
});
