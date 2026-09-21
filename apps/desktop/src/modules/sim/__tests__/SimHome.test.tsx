/* When the Sim module talks to the server, and what a delete reaches.
 *
 * Two things that were wrong at the seam between the local archive and the
 * team's. The listing is re-read from disk every six seconds and used to be
 * synced with the server every time -- a whole-table read, a per-user read
 * and possibly a fifty-row upsert, per client, ten times a minute, whether or
 * not anything had changed. And deleting a run removed its directory and
 * left its row, so the run came straight back from the server with a cloud
 * icon, still ranked. */
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { SimRun } from "../api";

const listRuns = vi.fn<() => Promise<SimRun[]>>();
const deleteRun = vi.fn<(id: string) => Promise<void>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    simStatus: vi.fn(async () => ({
      exePath: "C:/sim/fsae-sim.exe", exeConfigured: true, version: "fsae-sim 0.3.0",
      runsDir: "C:/runs", runCount: 1, searched: [],
    })),
    simListRuns: () => listRuns(),
    simDeleteRun: (id: string) => deleteRun(id),
    readRunTelemetry: vi.fn(async () => null),
    simLaunch: vi.fn(),
    simImportRun: vi.fn(),
    // The module keeps the simulator current on its own; here the feed has
    // nothing to say.
    simAvailableBuild: vi.fn(async () => null),
    simFeedPlatforms: vi.fn(async () => []),
    simInstall: vi.fn(),
    onSimInstallProgress: () => () => {},
  };
});

const fetchShared = vi.fn<() => Promise<SimRun[]>>();
const push = vi.fn(async () => ({
  pushed: 0, telemetryPushed: 0, telemetryPruned: 0, telemetrySwept: 0, skippedNotMine: 0, skippedStale: 0, error: null,
}));
const deleteShared = vi.fn<(client: unknown, id: string) => Promise<void>>();
vi.mock("../lib/share", () => ({
  fetchSharedRuns: () => fetchShared(),
  pushRuns: () => push(),
  fetchSharedTelemetry: vi.fn(),
  deleteSharedRun: (client: unknown, id: string) => deleteShared(client, id),
  telemetryToKeep: () => new Set<string>(),
  KEEP_BEST: 3,
  KEEP_RECENT: 3,
}));

vi.mock("../../../auth/AuthShell", () => {
  // Stable across renders, as the real auth state is: a fresh `user` object
  // every call would read as signing in on every render.
  const user = { id: "u1" };
  const client = {};
  return {
    useHeliosAuth: () => ({ user, client }),
    userDisplayName: () => "Nick",
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { SimHome } from "../SimHome";

// Today, so the runs table has one day to open. See RunsTable.test.tsx.
const today = (hour: number) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`, telemetryBytes: 1024,
    driver: "Sam", driverId: "u1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: today(12), finishedReason: "finished", profile: "wheel", detectedInput: "wheel",
    device: null, physics: "native", simVersion: "0.3.0", synthetic: false, samples: 4100,
    assists: { traction: false, abs: false, autoShift: false }, laps: [],
    stats: {
      durationS: 41, distanceM: 685, laps: 1, bestLapS: 41.2, bestLapRawS: 41.2,
      bestLapNumber: 1, bestSectors: [], theoreticalBestS: null, totalCones: 0,
      totalOffCourse: 0, peakSpeedKph: 90, peakRpm: 12000, peakLatG: 1.4,
      peakBrakeG: 1.3, peakAccelG: 1.1, avgSpeedMps: 16, fullThrottleFrac: 0.3,
      brakingFrac: 0.2, offTrackS: 0, ffbClippedFrac: 0,
    },
    ...over,
  } as SimRun;
}

describe("SimHome", () => {
  beforeEach(() => {
    localStorage.clear();
    listRuns.mockReset();
    fetchShared.mockReset();
    fetchShared.mockResolvedValue([]);
    push.mockClear();
    deleteRun.mockReset();
    deleteRun.mockResolvedValue(undefined);
    deleteShared.mockReset();
    deleteShared.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("syncs when the set of local runs changes, not every time the disk is read", async () => {
    vi.useFakeTimers();
    const a = run({ runId: "a" });
    // A fresh array of fresh objects every time, which is what the six-second
    // poll hands back whether or not anything changed.
    listRuns.mockImplementation(async () => [{ ...a }]);
    render(<SimHome active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(push).toHaveBeenCalledTimes(1);

    // Two more polls, nothing new on disk: nothing goes to the server.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(push).toHaveBeenCalledTimes(1);

    // A run is written: the next poll sees a new id, and that syncs.
    listRuns.mockImplementation(async () => [{ ...a }, run({ runId: "b", startedAt: today(13) })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("takes a deleted run off the board too, before the server has even answered", async () => {
    const a = run({ runId: "a" });
    listRuns.mockImplementation(async () => [{ ...a }]);
    const onBoard = { ...a, remote: true, dir: "", telemetryPath: "", telemetryBytes: 0 };
    // The first read has the run on the board, as it would. Every later read
    // hangs: the delete has not landed on the server yet, and the table must
    // not wait for it.
    fetchShared.mockResolvedValueOnce([onBoard]).mockImplementation(() => new Promise(() => {}));
    const { container } = render(<SimHome active />);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    // Open the day, select the run, delete it.
    fireEvent.click(container.querySelector("tbody tr")!);
    fireEvent.click(screen.getByText("Sam"));
    fireEvent.click(screen.getByRole("button", { name: /delete run/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete for good/i }));
    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(deleteShared).toHaveBeenCalledWith(expect.anything(), "a"));
    // Gone from the table now -- not re-merged from the shared copy with a
    // cloud icon while the server catches up.
    expect(screen.queryByText("Sam")).toBeNull();
  });
});
