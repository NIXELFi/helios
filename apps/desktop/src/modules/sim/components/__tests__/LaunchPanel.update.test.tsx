/* The simulator's update path.
 *
 * Helios used to consult the build feed only when it could not find a
 * simulator at all, so once you had one it never looked again -- a fix
 * published to the feed could not reach anybody who had already installed.
 * These cover the two halves of the banner that fixes that: reading the
 * installed version out of what the executable prints, and deciding that the
 * feed has something else. */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installedVersion } from "../LaunchPanel";
import type { SimStatus, SimBuild } from "../../api";

const available = vi.fn<() => Promise<SimBuild | null>>();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    simAvailableBuild: () => available(),
    simInstall: vi.fn(),
    simStatus: vi.fn(),
    simLaunch: vi.fn(),
    simSetExePath: vi.fn(),
    onSimInstallProgress: () => () => {},
  };
});

function status(over: Partial<SimStatus> = {}): SimStatus {
  return {
    exePath: "C:/Helios/sim/0.1.0/fsae-sim.exe",
    exeConfigured: true,
    version: "fsae-sim 0.1.0",
    runsDir: "C:/Helios/sim-runs",
    runCount: 3,
    searched: [],
    ...over,
  };
}

function build(over: Partial<SimBuild> = {}): SimBuild {
  return {
    version: "0.2.0",
    platform: "windows",
    url: "https://x.supabase.co/storage/v1/object/public/sim/windows/0.2.0/fsae-sim.exe",
    sha256: "a".repeat(64),
    bytes: 7_244_288,
    notes: null,
    published: "2026-09-19T00:00:00Z",
    ...over,
  };
}

describe("installedVersion", () => {
  it("reads the version out of what the executable prints", () => {
    expect(installedVersion(status())).toBe("0.1.0");
    expect(installedVersion(status({ version: "fsae-sim 1.10.3" }))).toBe("1.10.3");
  });

  it("has no answer when the executable never reported one", () => {
    expect(installedVersion(status({ version: null }))).toBeNull();
    expect(installedVersion(status({ version: "   " }))).toBeNull();
    expect(installedVersion(null)).toBeNull();
  });
});

describe("the update banner", () => {
  beforeEach(() => {
    available.mockReset();
  });

  /** The banner lives inside LaunchPanel; render it the way the app does. */
  async function show(st: SimStatus | null, offered: SimBuild | null) {
    available.mockResolvedValue(offered);
    const { LaunchPanel } = await import("../LaunchPanel");
    render(
      <LaunchPanel
        status={st}
        driver={{ id: "d-1", name: "Nick" }}
        onStatusChange={vi.fn()}
        onLaunched={vi.fn()}
      />,
    );
  }

  it("offers a build the feed has and this machine does not", async () => {
    await show(status(), build());
    await waitFor(() => {
      expect(screen.getByText(/Simulator 0\.2\.0 is available/)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /Update to 0\.2\.0/ })).toBeTruthy();
    // Says what you have, so the choice is informed.
    expect(screen.getByText(/You have 0\.1\.0/)).toBeTruthy();
  });

  it("says nothing when the feed matches what is installed", async () => {
    await show(status(), build({ version: "0.1.0" }));
    await waitFor(() => expect(available).toHaveBeenCalled());
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it("offers an OLDER build too", async () => {
    // Difference, not order. Rolling back to a build known to work at an
    // event is a real thing to want, and a version comparison that refused
    // would be wrong in the moment it mattered most.
    await show(status({ version: "fsae-sim 0.9.0" }), build({ version: "0.2.0" }));
    await waitFor(() => {
      expect(screen.getByText(/Simulator 0\.2\.0 is available/)).toBeTruthy();
    });
    expect(screen.getByText(/You have 0\.9\.0/)).toBeTruthy();
  });

  it("says nothing when the feed is unreachable", async () => {
    available.mockRejectedValue(new Error("offline"));
    const { LaunchPanel } = await import("../LaunchPanel");
    render(
      <LaunchPanel status={status()} driver={null} onStatusChange={vi.fn()} onLaunched={vi.fn()} />,
    );
    await waitFor(() => expect(available).toHaveBeenCalled());
    // A rig at a test day is offline as a matter of course; that is not an error.
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it("says nothing when no simulator is installed — that is the other panel's job", async () => {
    await show(status({ exePath: null, version: null }), build());
    await waitFor(() => expect(available).toHaveBeenCalled());
    expect(screen.queryByText(/Update to/)).toBeNull();
    expect(screen.getByText(/not installed here/i)).toBeTruthy();
  });
});
