/* What the leaderboard says about its own rule.
 *
 * The scoring changed under it -- a lap that went off course stopped having
 * a time at all -- and the tooltip went on describing the old rule, with the
 * old number, as "what an event scores". It was neither what an event scores
 * (FSAE adds twenty seconds, not ten, and keeps the time) nor what this board
 * does. A tooltip explaining the wrong rule is worse than no tooltip. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Leaderboard } from "../Leaderboard";
import type { SimRun } from "../../api";

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`, telemetryBytes: 1024,
    driver: "Nick", driverId: "d-1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-19T10:00:00Z", finishedReason: "finished", profile: "wheel",
    detectedInput: "wheel", device: null, physics: "native", simVersion: "0.6.0",
    synthetic: false, samples: 4100, assists: { traction: false, abs: false, autoShift: false },
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

const props = { canReplay: true, onOpenRun: vi.fn(), onReplayRun: vi.fn() };

describe("Leaderboard", () => {
  it("explains the scoring it actually uses", () => {
    render(<Leaderboard {...props} runs={[run({ runId: "a" })]} />);
    const title = screen.getByText("Recent records").getAttribute("title") ?? "";
    expect(title).toMatch(/two seconds a cone/);
    expect(title).toMatch(/off course/);
    expect(title).toMatch(/FSAE/);
    expect(title).not.toMatch(/ten an excursion|what an event scores/);
  });

  it("names going off course among the reasons a course has nothing ranked", () => {
    const off = run({
      runId: "off",
      laps: [{ lap: 1, raw: 43, cones: 0, off: 1, total: 43, valid: false, sectors: [], startedAtS: 0 }],
      stats: { ...run({ runId: "x" }).stats, bestLapS: null, bestLapNumber: null, totalOffCourse: 1 },
    });
    render(<Leaderboard {...props} runs={[off]} />);
    expect(screen.getByText(/Nothing ranked here yet/).textContent).toMatch(/went off course/);
  });

  it("offers an average-of-recent-runs ranking beside the fastest lap", () => {
    const runs = [40, 42, 44].map((t, i) =>
      run({ runId: `r${i}`, startedAt: `2026-09-1${i}T10:00:00Z`, stats: { ...run({ runId: "x" }).stats, bestLapS: t, bestLapRawS: t } }),
    );
    render(<Leaderboard {...props} runs={runs} />);
    // Fastest by default: the driver's best lap is what shows.
    expect(screen.getByRole("button", { name: /Fastest lap/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Average of last 15/ }));
    expect(screen.getByRole("button", { name: /Average of last 15/ }).getAttribute("aria-pressed")).toBe("true");
    // (40 + 42 + 44) / 3 = 42.000, three runs counted of the fifteen the window holds.
    expect(screen.getByText("42.000")).toBeTruthy();
    expect(screen.getByTestId("counted").textContent).toBe("3/15");
    expect(screen.getByText("Average").getAttribute("title")).toMatch(/newest 15 clean runs/);
  });
});

describe("generated courses have their own tab", () => {
  it("keeps them off the competition board and shows them under their own", () => {
    const runs = [
      run({ runId: "a", track: "autocross", trackName: "Autocross 2026" }),
      run({ runId: "g", track: "gen-ax-K7Q2", trackName: "Autocross K7Q2", stats: { ...run({ runId: "x" }).stats, bestLapS: 39, bestLapRawS: 39 } }),
    ];
    render(<Leaderboard {...props} runs={runs} />);
    // Competition by default: the real course only.
    expect(screen.getByText("Autocross 2026")).toBeTruthy();
    expect(screen.queryByText("Autocross K7Q2")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Generated courses/ }));
    expect(screen.getByText("Autocross K7Q2")).toBeTruthy();
    expect(screen.queryByText("Autocross 2026")).toBeNull();
  });

  it("does not offer the tab when nothing generated has been driven", () => {
    render(<Leaderboard {...props} runs={[run({ runId: "a" })]} />);
    expect(screen.queryByRole("tab", { name: /Generated courses/ })).toBeNull();
  });
});

describe("sector records you can click", () => {
  const lapOf = (n: number, sectors: number[], over: Record<string, unknown> = {}) => ({
    lap: n, raw: sectors.reduce((a, b) => a + b, 0), cones: 0, off: 0,
    total: sectors.reduce((a, b) => a + b, 0), valid: true, sectors, startedAtS: 2, ...over,
  });
  const stats = (best: number, bestLapNumber = 1) =>
    ({ ...run({ runId: "x" }).stats, bestLapS: best, bestLapRawS: best, bestLapNumber });

  it("opens a card that counts the cone, from the keyboard as well as the mouse", () => {
    const runs = [
      run({ runId: "j", driver: "Jordan", driverId: "d-2", formatVersion: 4,
        laps: [lapOf(3, [12, 12.43, 13], { cones: 1, sectorCones: [0, 1, 0] })], stats: stats(39.43, 3) }),
      run({ runId: "n", driver: "Nick", driverId: "d-1", formatVersion: 4,
        laps: [lapOf(1, [12.5, 14.81, 13.4])], stats: stats(40.71) }),
    ];
    const onWatch = vi.fn();
    render(<Leaderboard {...props} runs={runs} driverId="d-1" onWatchSector={onWatch} onCompareSector={vi.fn()} />);
    const chip = screen.getByRole("button", { name: /Sector 2 record 14\.430 seconds by Jordan/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    chip.focus();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("sector-card-target").textContent).toMatch(/S2 record 14\.430 s \(incl\. 1 cone\) — Jordan, lap 3/);
    expect(screen.getByTestId("sector-card-mine").textContent).toMatch(/Your best S2 14\.810 s.*\+0\.380/);
    fireEvent.click(screen.getByRole("button", { name: /Watch in sim/ }));
    expect(onWatch).toHaveBeenCalledWith(expect.objectContaining({
      sector: 1, target: expect.objectContaining({ runId: "j", lap: 3 }), against: expect.objectContaining({ runId: "n", lap: 1 }),
    }));
    // Escape closes it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("sector-card")).toBeNull();
  });

  it("makes only your own theoretical clickable, and compares it with your best lap", () => {
    const runs = [
      run({ runId: "n1", driver: "Nick", driverId: "d-1", formatVersion: 4,
        laps: [lapOf(1, [12, 14, 13])], stats: stats(39) }),
      run({ runId: "n2", driver: "Nick", driverId: "d-1", formatVersion: 4,
        laps: [lapOf(1, [12.5, 13, 14])], stats: stats(39.5) }),
      run({ runId: "j", driver: "Jordan", driverId: "d-2", formatVersion: 4,
        laps: [lapOf(1, [13, 13, 13])], stats: stats(39.2) }),
    ];
    render(<Leaderboard {...props} runs={runs} driverId="d-1" onWatchSector={vi.fn()} onCompareSector={vi.fn()} />);
    const own = screen.getByTitle(/where the perfect lap beats the real one/);
    expect(own.textContent).toBe("38.000");
    fireEvent.click(own);
    // S2 is where the perfect lap gains most: 13.0 on n2 against 14.0 on the best lap.
    expect(screen.getByRole("button", { name: "S2" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("sector-card-mine").textContent).toMatch(/Your best lap's S2 14\.000 s.*\+1\.000/);
    // Jordan's row is plain text.
    expect(screen.getAllByTitle(/where the perfect lap beats the real one/)).toHaveLength(1);
  });
});

describe("the bicycle and the 4-wheel model rank side by side", () => {
  const base = run({ runId: "x" }).stats;
  it("puts each model's time on its own board for the same course, with the setup it was set on", () => {
    const bike = run({
      runId: "bike", driver: "Josh", driverId: "d-josh",
      stats: { ...base, bestLapS: 40.5, vehicleModel: 2, counted: true, setup: { "roll.rsdFront": 0.48, brakeBiasFront: 0.65 } },
    });
    const dt = run({
      runId: "dt", driver: "Edgar", driverId: "d-edgar",
      stats: { ...base, bestLapS: 39.9, vehicleModel: 3, counted: true, setup: { "roll.rsdFront": 0.47, "dt.toeInRearDeg": -0.5 } },
    });
    render(<Leaderboard {...props} runs={[bike, dt]} />);
    const bikeBoard = screen.getByRole("heading", { name: "Bicycle" }).closest("section")!;
    const dtBoard = screen.getByRole("heading", { name: /4-wheel/ }).closest("section")!;
    expect(bikeBoard.textContent).toMatch(/Josh/);
    expect(bikeBoard.textContent).not.toMatch(/Edgar/);
    expect(dtBoard.textContent).toMatch(/Edgar/);
    expect(dtBoard.textContent).not.toMatch(/Josh/);
    // Exact setups, beside the time.
    expect(bikeBoard.textContent).toMatch(/RSD\s*48% F/);
    expect(dtBoard.textContent).toMatch(/Toe\s*\?\/-0\.5/);
  });

  it("keeps a run the simulator did not count off both boards", () => {
    const modified = run({ runId: "m", stats: { ...base, bestLapS: 30, vehicleModel: 2, counted: false } });
    render(<Leaderboard {...props} runs={[modified]} />);
    expect(screen.queryByText("30.000")).toBeNull();
  });

  it("shows an empty 4-wheel board beside the bicycle's rather than hiding it", () => {
    render(<Leaderboard {...props} runs={[run({ runId: "only-bike" })]} />);
    expect(screen.getByRole("heading", { name: /4-wheel/ })).toBeTruthy();
    expect(screen.getByText(/No times on this model here yet/)).toBeTruthy();
  });
});

describe("physics eras: an update starts a fresh board and keeps the old one", () => {
  const base = run({ runId: "x" }).stats;
  const old = run({
    runId: "old", driver: "Edgar", driverId: "d-edgar", simVersion: "0.7.1",
    stats: { ...base, bestLapS: 38.0, vehicleModel: 3, counted: true },
  });
  const fresh = run({
    runId: "new", driver: "Ralf", driverId: "d-ralf", simVersion: "0.7.4",
    stats: { ...base, bestLapS: 40.0, vehicleModel: 3, counted: true, physicsRev: 2 },
  });

  it("shows the current era by default, and the older one a click away", () => {
    render(<Leaderboard {...props} runs={[old, fresh]} />);
    const board = () => screen.getByRole("heading", { name: /4-wheel/ }).closest("section")!;
    expect(board().textContent).toMatch(/Ralf/);
    expect(board().textContent).not.toMatch(/Edgar/);
    fireEvent.click(within(screen.getByRole("group", { name: "Physics era" })).getByRole("button", { name: /rev 1/ }));
    expect(board().textContent).toMatch(/Edgar/);
    expect(board().textContent).not.toMatch(/Ralf/);
  });

  it("does not offer an era picker when a model has only one era", () => {
    render(<Leaderboard {...props} runs={[fresh]} />);
    expect(screen.queryByRole("group", { name: "Physics era" })).toBeNull();
  });
});

describe("launching the 4-wheel model from its board", () => {
  it("offers Launch 4-wheel on the 4-wheel board and launches that course on model 3", () => {
    const onLaunchCourse = vi.fn();
    render(<Leaderboard {...props} onLaunchCourse={onLaunchCourse} runs={[run({ runId: "b" })]} />);
    const buttons = screen.getAllByRole("button", { name: "Launch 4-wheel" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onLaunchCourse).toHaveBeenCalledWith("autocross", 3);
  });
});

describe("board rows", () => {
  const st = (t: number) => ({ ...run({ runId: "x" }).stats, bestLapS: t, bestLapRawS: t });
  const runs = [
    run({ runId: "j", driver: "Jordan", driverId: "d-2", stats: st(39) }),
    run({ runId: "n", driver: "Nick", driverId: "d-1", stats: st(40) }),
  ];

  it("marks your own row and opens a run from the keyboard", () => {
    const onOpenRun = vi.fn();
    render(<Leaderboard {...props} onOpenRun={onOpenRun} runs={runs} driverId="d-1" />);
    const mine = screen.getAllByText("you")[0]!.closest("tr")!;
    expect(mine.textContent).toMatch(/Nick/);
    expect(mine.className).toMatch(/bg-asu-gold/);
    mine.focus();
    fireEvent.keyDown(mine, { key: "Enter" });
    expect(onOpenRun).toHaveBeenCalledWith("n");
  });

  it("chases a row and compares it with your best", () => {
    const onChaseRun = vi.fn();
    const onCompareRuns = vi.fn();
    render(<Leaderboard {...props} runs={runs} driverId="d-1" onChaseRun={onChaseRun} onCompareRuns={onCompareRuns} />);
    fireEvent.click(screen.getByRole("button", { name: "Drive against Jordan's 39.000" }));
    expect(onChaseRun).toHaveBeenCalledWith("j");
    fireEvent.click(screen.getByRole("button", { name: "Compare Jordan's lap with your best in Logs" }));
    expect(onCompareRuns).toHaveBeenCalledWith("j", "n", "my PB");
    // Your own row compares with the leader.
    fireEvent.click(screen.getByRole("button", { name: "Compare your best with the leader's in Logs" }));
    expect(onCompareRuns).toHaveBeenLastCalledWith("n", "j", "leader");
  });

  it("says when it is showing this machine's runs only", () => {
    const onSignIn = vi.fn();
    const { unmount } = render(<Leaderboard {...props} runs={runs} teamState="signed-out" onSignIn={onSignIn} />);
    expect(screen.getByTestId("board-local-only").textContent).toMatch(/this machine.s runs only.*sign in for team times/);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalled();
    unmount();
    render(<Leaderboard {...props} runs={runs} teamState="offline" />);
    expect(screen.getByTestId("board-local-only").textContent).toMatch(/offline/);
  });

  it("lists recent records per board rather than one best lap across all of them", () => {
    const four = run({
      runId: "f", driver: "Ralf", driverId: "d-3", simVersion: "0.7.4",
      stats: { ...st(44), vehicleModel: 3, physicsRev: 2 },
    });
    render(<Leaderboard {...props} runs={[...runs, four]} />);
    const strip = screen.getByTestId("recent-records");
    // Ralf's 44.000 is the 4-wheel record even though 39.000 is quicker: a
    // different car is a different board.
    expect(strip.textContent).toMatch(/44\.000Ralf/);
    expect(strip.textContent).toMatch(/4-wheel/);
    expect(strip.textContent).toMatch(/39\.000Jordan/);
  });

  it("labels time found with the car it was found on", () => {
    const later = run({ runId: "n2", driver: "Nick", driverId: "d-1", startedAt: "2026-09-20T10:00:00Z", stats: st(39.5) });
    render(<Leaderboard {...props} runs={[...runs, later]} />);
    const row = screen.getByText("−0.500 s").closest("tr")!;
    expect(row.textContent).toMatch(/Autocross · Bicycle/);
  });
});
