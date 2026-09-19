/* The simulator keeps itself current.
 *
 * The feed used to be a banner with a button, which at a test day nobody
 * pressed. Now a build that differs from the one installed is installed on
 * its own. These cover what must and must not trigger that: a different
 * version does, the same one does not, an unreachable feed does not, a
 * machine with no simulator does not (that is the opt-in panel's job), and a
 * failure is reported once and retried only on request. */
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { SimStatus, SimBuild, SimInstalled } from "../../api";

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

function status(over: Partial<SimStatus> = {}): SimStatus {
  return {
    exePath: "C:/Helios/sim/0.4.0/fsae-sim.exe",
    exeConfigured: true,
    version: "fsae-sim 0.4.0",
    runsDir: "C:/Helios/sim-runs",
    runCount: 3,
    searched: [],
    ...over,
  };
}

function build(over: Partial<SimBuild> = {}): SimBuild {
  return {
    version: "0.5.0",
    platform: "windows",
    url: "https://x.supabase.co/storage/v1/object/public/sim/windows/0.5.0/fsae-sim.exe",
    sha256: "a".repeat(64),
    bytes: 7_244_288,
    notes: null,
    published: "2026-09-19T00:00:00Z",
    ...over,
  };
}

describe("useSimAutoUpdate", () => {
  beforeEach(async () => {
    available.mockReset();
    install.mockReset();
    statusNow.mockReset();
    const { resetAutoUpdateAttempts } = await import("../useSimAutoUpdate");
    resetAutoUpdateAttempts();
  });

  async function hook(st: SimStatus | null) {
    const { useSimAutoUpdate } = await import("../useSimAutoUpdate");
    const onStatusChange = vi.fn();
    const r = renderHook(() => useSimAutoUpdate(st, onStatusChange));
    return { ...r, onStatusChange };
  }

  it("installs a build the feed has and this machine does not, without being asked", async () => {
    available.mockResolvedValue(build());
    const after = status({ exePath: "C:/Helios/sim/0.5.0/fsae-sim.exe", version: "fsae-sim 0.5.0" });
    install.mockResolvedValue({ version: "0.5.0", exePath: after.exePath!, bytes: 7_244_288 });
    statusNow.mockResolvedValue(after);
    const { result, onStatusChange } = await hook(status());
    await waitFor(() => expect(install).toHaveBeenCalledWith("0.5.0"));
    await waitFor(() => expect(result.current.installing).toBe(false));
    expect(onStatusChange).toHaveBeenCalledWith(after);
    expect(result.current.installed).toBe("0.5.0");
    expect(result.current.error).toBeNull();
  });

  it("does nothing when the feed matches what is installed", async () => {
    available.mockResolvedValue(build({ version: "0.4.0" }));
    const { result } = await hook(status());
    await waitFor(() => expect(result.current.build?.version).toBe("0.4.0"));
    expect(install).not.toHaveBeenCalled();
    expect(result.current.installing).toBe(false);
  });

  it("rolls BACK too: difference, not order", async () => {
    // Rolling the feed back to a build known to work at an event has to roll
    // every rig back with it.
    available.mockResolvedValue(build({ version: "0.3.0" }));
    install.mockResolvedValue({ version: "0.3.0", exePath: "x", bytes: 1 });
    statusNow.mockResolvedValue(status({ version: "fsae-sim 0.3.0" }));
    await hook(status({ version: "fsae-sim 0.4.0" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("0.3.0"));
  });

  it("does nothing when the feed is unreachable, and says so quietly", async () => {
    available.mockRejectedValue(new Error("offline"));
    const { result } = await hook(status());
    await waitFor(() => expect(result.current.feedError).toBe("offline"));
    expect(install).not.toHaveBeenCalled();
  });

  it("does not hand a simulator to a machine that never had one", async () => {
    // The first install is the not-installed panel's opt-in.
    available.mockResolvedValue(build());
    const { result } = await hook(status({ exePath: null, version: null }));
    await waitFor(() => expect(result.current.build).not.toBeNull());
    expect(install).not.toHaveBeenCalled();
  });

  it("reports a failed install once and retries only when asked", async () => {
    available.mockResolvedValue(build());
    install.mockRejectedValueOnce(new Error("sha256 mismatch"));
    const { result, rerender } = await hook(status());
    await waitFor(() => expect(result.current.error).toBe("sha256 mismatch"));
    expect(install).toHaveBeenCalledTimes(1);
    // A re-render is not a retry.
    rerender();
    await new Promise((r) => setTimeout(r, 20));
    expect(install).toHaveBeenCalledTimes(1);
    // Asking is.
    install.mockResolvedValue({ version: "0.5.0", exePath: "x", bytes: 1 });
    statusNow.mockResolvedValue(status({ version: "fsae-sim 0.5.0" }));
    act(() => result.current.retry());
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
