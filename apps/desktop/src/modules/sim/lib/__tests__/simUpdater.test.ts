/* The app-wide simulator updater: what a release broadcast may and may not do.
 *
 * The broadcast is on a public channel, so it is treated as a hint. These pin
 * that down: a signal makes Helios read the feed, and only the feed decides
 * what gets installed; signals are coalesced so a flood cannot become a flood
 * of feed reads; and a machine with no simulator is never handed one. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SimBuild, SimInstalled, SimStatus } from "../../api";

const available = vi.fn<() => Promise<SimBuild | null>>();
const install = vi.fn<(v: string) => Promise<SimInstalled>>();
const statusNow = vi.fn<() => Promise<SimStatus>>();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    simAvailableBuild: () => available(),
    simInstall: (v: string) => install(v),
    simStatus: () => statusNow(),
    onSimInstallProgress: () => () => {},
  };
});

import {
  SIGNAL_MIN_INTERVAL_MS, getSimUpdaterState, requestSimUpdateCheck, resetSimUpdater,
} from "../simUpdater";

function status(version: string | null, exePath: string | null = "C:/Helios/sim/x/fsae-sim.exe"): SimStatus {
  return {
    exePath, exeConfigured: true, version: version ? `fsae-sim ${version}` : null,
    runsDir: "C:/Helios/sim-runs", runCount: 0, searched: [],
  };
}

function build(version: string): SimBuild {
  return {
    version, platform: "windows",
    url: `https://x.supabase.co/storage/v1/object/public/sim/windows/${version}/fsae-sim.exe`,
    sha256: "a".repeat(64), bytes: 1, notes: null, published: null,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("simUpdater", () => {
  beforeEach(() => {
    resetSimUpdater();
    available.mockReset();
    install.mockReset();
    statusNow.mockReset();
    install.mockImplementation(async (v) => ({ version: v, exePath: "x", bytes: 1 }));
  });
  afterEach(() => vi.useRealTimers());

  it("a signal installs what the FEED names, reading the status itself", async () => {
    available.mockResolvedValue(build("0.6.10"));
    statusNow.mockResolvedValue(status("0.6.9"));
    await requestSimUpdateCheck("signal");
    expect(install).toHaveBeenCalledWith("0.6.10");
    expect(getSimUpdaterState().installed).toBe("0.6.10");
    expect(getSimUpdaterState().installSeq).toBe(1);
  });

  it("a signal with nothing new on the feed installs nothing", async () => {
    // A forged or replayed message: the feed still names what is installed.
    available.mockResolvedValue(build("0.6.9"));
    statusNow.mockResolvedValue(status("0.6.9"));
    await requestSimUpdateCheck("signal");
    expect(available).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });

  it("never hands a simulator to a machine that does not have one", async () => {
    available.mockResolvedValue(build("0.6.10"));
    statusNow.mockResolvedValue(status(null, null));
    await requestSimUpdateCheck("startup");
    expect(install).not.toHaveBeenCalled();
  });

  it("coalesces a burst of signals into one check now and one trailing check", async () => {
    vi.useFakeTimers();
    available.mockResolvedValue(build("0.6.9"));
    statusNow.mockResolvedValue(status("0.6.9"));
    await requestSimUpdateCheck("signal");
    for (let i = 0; i < 50; i++) await requestSimUpdateCheck("signal");
    expect(available).toHaveBeenCalledTimes(1);
    // The trailing check still happens: a real second publish inside the
    // window (the other platform) must not be lost.
    await vi.advanceTimersByTimeAsync(SIGNAL_MIN_INTERVAL_MS + 10);
    expect(available).toHaveBeenCalledTimes(2);
    // And nothing further without a new signal.
    await vi.advanceTimersByTimeAsync(SIGNAL_MIN_INTERVAL_MS * 3);
    expect(available).toHaveBeenCalledTimes(2);
  });

  it("does not throttle the module's own check", async () => {
    available.mockResolvedValue(build("0.6.9"));
    statusNow.mockResolvedValue(status("0.6.9"));
    await requestSimUpdateCheck("signal");
    await requestSimUpdateCheck("module", status("0.6.9"));
    expect(available).toHaveBeenCalledTimes(2);
  });

  it("a check asked for mid-check runs once more afterwards, not in parallel", async () => {
    let release!: (b: SimBuild) => void;
    available.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    available.mockResolvedValue(build("0.6.10"));
    statusNow.mockResolvedValue(status("0.6.9"));
    const first = requestSimUpdateCheck("startup");
    void requestSimUpdateCheck("module");
    void requestSimUpdateCheck("module");
    expect(available).toHaveBeenCalledTimes(1);
    release(build("0.6.9"));
    await first;
    await flush(); await flush(); await flush();
    expect(available).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("0.6.10");
  });

  it("an unreachable feed is reported quietly and installs nothing", async () => {
    available.mockRejectedValue(new Error("offline"));
    await requestSimUpdateCheck("timer");
    expect(getSimUpdaterState().feedError).toBe("offline");
    expect(install).not.toHaveBeenCalled();
  });
});
