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

describe("RunDetail against the board", () => {
  beforeEach(() => {
    readRun.mockReset();
    readRun.mockResolvedValue({ manifest: {} });
  });

  // Current runs, so they rank: the base fixture is a 0.3.0 run, which
  // predates the autocross slaloms and ranks nowhere.
  const ranked = (over: Partial<SimRun>) => run({
    simVersion: "0.7.5",
    ...over,
    stats: { ...run().stats, vehicleModel: 2, ...(over.stats ?? {}) },
  });
  const ralf = ranked({ runId: "ralf", finishedReason: "window-closed", stats: { ...run().stats, bestLapS: 41.2 } });
  const mine = ranked({ runId: "mine", driver: "Me", driverId: "me", stats: { ...run().stats, bestLapS: 40.5 } });
  const jordan = ranked({ runId: "jordan", driver: "Jordan", driverId: "u-j", stats: { ...run().stats, bestLapS: 39 } });
  const fourWheel = ranked({ runId: "four", driver: "Jordan", driverId: "u-j", stats: { ...run().stats, bestLapS: 30, vehicleModel: 3 } });
  const all = [ralf, mine, jordan, fourWheel];

  it("says which board the run is on and where its driver stands", () => {
    render(<RunDetail {...props(ralf)} allRuns={all} />);
    expect(screen.getByText("Autocross · Bicycle · Wheel · rev 1")).toBeTruthy();
    expect(screen.getByTestId("board-position").textContent).toMatch(/P3 of 3 · \+2\.200 to Jordan/);
    expect(screen.getByText("Closed the simulator")).toBeTruthy();
  });

  it("offers ghosts from the same car only, your own best first, labelled", () => {
    render(<RunDetail {...props(ralf)} allRuns={all} />);
    const select = screen.getByRole("combobox", { name: "Ghost in replay" });
    const options = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(options[0]).toBe("No ghost");
    expect(options[1]).toMatch(/^Me — 40\.500 · .* · Bicycle \(your PB\)$/);
    expect(options[2]).toMatch(/^Jordan — 39\.000/);
    // The 4-wheel lap is a different car.
    expect(options.some((o) => /30\.000/.test(o ?? ""))).toBe(false);
  });

  it("drives against the reference you pick, not whatever the ghost picker says", () => {
    const p = props(ralf);
    render(<RunDetail {...p} allRuns={all} />);
    const ref = screen.getByRole("combobox", { name: "Reference lap for the live delta" });
    fireEvent.change(ref, { target: { value: "pb" } });
    fireEvent.click(button(/drive against your pb/i));
    expect(p.onChase).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "mine" }));
    fireEvent.change(ref, { target: { value: "leader" } });
    fireEvent.click(button(/drive against the leader/i));
    expect(p.onChase).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "jordan" }));
  });

  it("compares with your PB or the leader in Logs", () => {
    const onCompareInLogs = vi.fn();
    render(<RunDetail {...props(ralf)} allRuns={all} onCompareInLogs={onCompareInLogs} />);
    fireEvent.click(button(/my PB 40\.500/));
    expect(onCompareInLogs).toHaveBeenLastCalledWith(ralf, mine, "my PB");
    fireEvent.click(button(/leader 39\.000/));
    expect(onCompareInLogs).toHaveBeenLastCalledWith(ralf, jordan, "leader");
  });

  it("gives a lap that went off course no time, and measures no gap from it", () => {
    const r = ranked({
      runId: "en", track: "endurance", trackName: "Endurance 2026",
      laps: [
        { lap: 1, raw: 60, cones: 0, off: 1, total: 60, valid: false, sectors: [], startedAtS: 0 },
        { lap: 2, raw: 62, cones: 0, off: 0, total: 62, valid: true, sectors: [], startedAtS: 60 },
        { lap: 3, raw: 61, cones: 0, off: 0, total: 61, valid: true, sectors: [], startedAtS: 122 },
      ],
      stats: { ...run().stats, laps: 3, bestLapS: 61, bestLapNumber: 3, totalOffCourse: 1 },
    });
    render(<RunDetail {...props(r)} allRuns={[r]} />);
    const off = screen.getByTestId("lap-row-off");
    expect(off.textContent).toMatch(/off course/);
    expect(off.querySelector(".line-through")?.textContent).toBe("1:00.000");
    // Lap 2's gap is to lap 3, the best lap that counts: +1.000, not to lap 1.
    const counted = screen.getAllByTestId("lap-row");
    expect(counted[0]!.textContent).toMatch(/\+1\.000/);
  });

  it("shows a shared run's setup from its row when there is no manifest here", () => {
    render(<RunDetail {...props(shared({ stats: { ...run().stats, setup: { brakeBiasFront: 0.62, "roll.rsdFront": 0.5 } } }))} />);
    expect(screen.getByText("Run-to-run setup (2)")).toBeTruthy();
  });
});
