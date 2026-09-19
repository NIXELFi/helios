/* The detail panel for a run that is not on this machine.
 *
 * A shared run is a row and, sometimes, a storage object. The panel was
 * written for a directory: it read a manifest that does not exist and put the
 * error at the bottom in red, showed the local byte count of a file that is
 * not here, and offered buttons -- files, delete -- that acted on an empty
 * path. Worse, it disagreed with the runs table beside it about whether the
 * same run could be opened. These pin down what it says and offers for a run
 * that lives on the team's board. */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { RunDetail } from "../RunDetail";
import type { SimRun } from "../../api";

const readRun = vi.fn<() => Promise<unknown>>();
const deleteRun = vi.fn<() => Promise<void>>();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    simReadRun: () => readRun(),
    simDeleteRun: () => deleteRun(),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

function run(over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 99.2, runId: "r1", dir: "C:/runs/r1",
    telemetryPath: "C:/runs/r1/telemetry.csv", telemetryBytes: 4_000_000, driver: "Ralf",
    driverId: "u-ralf", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-19T10:00:00Z", finishedReason: "finished", profile: "wheel",
    detectedInput: "wheel", device: null, physics: "native", simVersion: "0.3.0",
    synthetic: false, samples: 3963, assists: { traction: false, abs: false, autoShift: false },
    laps: [],
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

/** As `rowToRun` builds one: no files here, and what the row said about the lap. */
function shared(over: Partial<SimRun> = {}): SimRun {
  return run({
    remote: true, dir: "", telemetryPath: "", telemetryBytes: 0, samples: 0,
    sharedBy: "Ralf Weber", subteam: "Chassis",
    telemetryObject: "u-ralf/r1.csv.gz", telemetrySharedBytes: 1_100_000,
    ...over,
  });
}

const props = (r: SimRun, driverId: string | null = "me") => ({
  run: r, allRuns: [r], canReplay: true, driverId,
  onClose: vi.fn(), onReplay: vi.fn(), onOpenInLogs: vi.fn(), onChase: vi.fn(), onDeleted: vi.fn(),
});

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("RunDetail for a shared run", () => {
  beforeEach(() => {
    readRun.mockReset();
    readRun.mockResolvedValue({ manifest: {} });
    deleteRun.mockReset();
    deleteRun.mockResolvedValue(undefined);
  });

  it("does not go looking for files it has not got", () => {
    render(<RunDetail {...props(shared())} />);
    expect(readRun).not.toHaveBeenCalled();
    expect(screen.queryByText(/cannot find/i)).toBeNull();
    // A local run is still read in full.
    render(<RunDetail {...props(run())} />);
    expect(readRun).toHaveBeenCalledTimes(1);
  });

  it("agrees with the runs table about what the run can do", () => {
    // The lap was shared: everything that needs the telemetry is on offer,
    // and says it will fetch first.
    const { unmount } = render(<RunDetail {...props(shared())} />);
    expect(button(/open in logs/i).disabled).toBe(false);
    expect(button(/open in logs/i).title).toMatch(/fetch ralf's lap/i);
    expect(button(/watch replay/i).disabled).toBe(false);
    expect(button(/drive against this lap/i).disabled).toBe(false);
    unmount();

    // Only the time was shared: nothing that needs the lap is on offer, and
    // every button says the same thing about why.
    render(<RunDetail {...props(shared({ telemetryObject: null, telemetrySharedBytes: 0 }))} />);
    for (const name of [/open in logs/i, /watch replay/i, /drive against this lap/i]) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).toMatch(/shared this run's time, not the lap itself/);
    }
  });

  it("describes the telemetry it can see rather than a file it cannot", () => {
    const { unmount } = render(<RunDetail {...props(shared())} />);
    expect(screen.getByText("1.0 MB shared")).toBeTruthy();
    // A row pushed before the count travelled has no sample count, and
    // "0 at 99 Hz" is a wrong number rather than a missing one.
    expect(screen.queryByText(/^0 at/)).toBeNull();
    unmount();
    render(<RunDetail {...props(shared({ telemetryObject: null }))} />);
    expect(screen.getByText(/time only/)).toBeTruthy();
  });

  it("shows the count once the row carries it", () => {
    render(<RunDetail {...props(shared({ samples: 3963 }))} />);
    expect(screen.getByText("3,963 at 99 Hz")).toBeTruthy();
  });

  it("offers neither the files nor a delete for a teammate's run", () => {
    render(<RunDetail {...props(shared())} />);
    expect(screen.queryByRole("button", { name: /show the files/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete run/i })).toBeNull();
  });

  it("lets you take your own run off the board, and says that is what it does", async () => {
    const mine = shared({ driverId: "me" });
    const p = props(mine);
    render(<RunDetail {...p} />);
    expect(screen.queryByRole("button", { name: /show the files/i })).toBeNull();
    fireEvent.click(button(/delete run/i));
    expect(screen.getByText(/removes it from the team's board\. There is no copy on this machine/)).toBeTruthy();
    fireEvent.click(button(/delete for good/i));
    await vi.waitFor(() => expect(p.onDeleted).toHaveBeenCalledWith("r1"));
    // No directory to delete for a run that was never here.
    expect(deleteRun).not.toHaveBeenCalled();
  });

  it("says how far a local delete reaches", async () => {
    const p = props(run({ driverId: "me" }));
    render(<RunDetail {...p} />);
    fireEvent.click(button(/delete run/i));
    expect(screen.getByText(/from this machine and from the team's board/)).toBeTruthy();
    fireEvent.click(button(/delete for good/i));
    await vi.waitFor(() => expect(p.onDeleted).toHaveBeenCalledWith("r1"));
    expect(deleteRun).toHaveBeenCalledTimes(1);

    // Somebody else's run on a shared rig: the disk is yours, the board
    // entry is theirs.
    render(<RunDetail {...props(run({ driverId: "u-ralf" }))} />);
    fireEvent.click(button(/delete run/i));
    expect(screen.getByText(/only its driver can take it down/)).toBeTruthy();
  });
});
