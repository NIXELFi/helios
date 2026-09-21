/* The simulator's update path, as the Launch tab shows it.
 *
 * The update itself is automatic and lives in `useSimAutoUpdate` (tested
 * beside it). The panel's job is to say what is happening and to keep the
 * launch button out of the way while the executable is being replaced. */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { LaunchPanel, installedVersion } from "../LaunchPanel";
import type { AutoUpdateState } from "../useSimAutoUpdate";
import type { SimStatus, SimBuild } from "../../api";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    simAvailableBuild: vi.fn().mockResolvedValue(null),
    simFeedPlatforms: vi.fn().mockResolvedValue(["windows"]),
    thisPlatform: () => "macos",
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

function idle(over: Partial<AutoUpdateState> = {}): AutoUpdateState {
  return {
    build: null, installing: false, got: 0, error: null, feedError: null,
    installed: null, retry: vi.fn(), ...over,
  };
}

function show(st: SimStatus | null, update: AutoUpdateState) {
  render(
    <LaunchPanel
      status={st}
      driver={{ id: "d-1", name: "Nick" }}
      onStatusChange={vi.fn()}
      onLaunched={vi.fn()}
      update={update}
    />,
  );
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

describe("the launch tab while the simulator updates itself", () => {
  it("says what is being installed and holds the launch button", () => {
    show(status(), idle({ build: build(), installing: true, got: 3_622_144 }));
    expect(screen.getByText(/Updating the simulator to 0\.2\.0/)).toBeTruthy();
    expect(screen.getByText(/Replacing 0\.1\.0 · 50%/)).toBeTruthy();
    const launch = screen.getByRole("button", { name: /Updating…/ }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
  });

  it("offers a retry when the install failed, and the launch button works on what is there", () => {
    const retry = vi.fn();
    show(status(), idle({ build: build(), error: "sha256 mismatch", retry }));
    expect(screen.getByText(/Could not update the simulator to 0\.2\.0/)).toBeTruthy();
    expect(screen.getByText(/sha256 mismatch · still on 0\.1\.0/)).toBeTruthy();
    screen.getByRole("button", { name: /Try again/ }).click();
    expect(retry).toHaveBeenCalled();
    const launch = screen.getByRole("button", { name: /Launch simulator/ }) as HTMLButtonElement;
    expect(launch.disabled).toBe(false);
  });

  it("says when it has just installed one", () => {
    show(status({ version: "fsae-sim 0.2.0" }), idle({ build: build(), installed: "0.2.0" }));
    expect(screen.getByText(/Simulator 0\.2\.0 installed just now/)).toBeTruthy();
  });

  it("says nothing when the feed matches what is installed", () => {
    show(status({ version: "fsae-sim 0.2.0" }), idle({ build: build() }));
    expect(screen.queryByText(/Updating the simulator/)).toBeNull();
    expect(screen.queryByText(/installed just now/)).toBeNull();
  });

  it("says nothing when no simulator is installed — that is the other panel's job", () => {
    show(status({ exePath: null, version: null }), idle({ build: build() }));
    expect(screen.queryByText(/Updating the simulator/)).toBeNull();
    expect(screen.getByText(/not installed here/i)).toBeTruthy();
  });

  it("prints the sharing rule, both halves of it, where the run is started", () => {
    show(status(), idle());
    // Two rules since generated courses became unbounded in number: a driver
    // reading only the fixed numbers on the Launch tab would be told the wrong
    // thing about every seed they drive.
    expect(screen.getByText(/best 3 and latest 3 on each fixed course/)).toBeTruthy();
    expect(screen.getByText(/on a generated one/)).toBeTruthy();
  });

  it("says which platforms the feed has when there is nothing for this one", async () => {
    // A Mac reading a feed that only ever carried a Windows build used to be
    // told the simulator was "not installed", as if the driver had skipped a
    // step. The truth is that nothing has been published for macOS.
    render(
      <LaunchPanel
        status={status({ exePath: null, exeConfigured: false, version: null })}
        driver={null}
        onStatusChange={vi.fn()}
        onLaunched={vi.fn()}
        update={{ build: null, installing: false, got: 0, error: null } as AutoUpdateState}
      />,
    );
    const note = await screen.findByTestId("no-build-here");
    expect(note.textContent).toMatch(/No macOS build has been published yet/);
    expect(note.textContent).toMatch(/Windows only/);
    expect(screen.queryByText(/Install the simulator/)).toBeNull();
  });
});
