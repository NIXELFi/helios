/* The runs table is the whole team's archive, so how much of it is on screen
 * at once is a real decision and not a styling detail. These cover the two
 * halves of it: nothing is open until you ask, and anything picked somewhere
 * else opens itself so you are not staring at a table with no visible
 * selection. */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { RunsTable, resetRunsView } from "../RunsTable";
import type { SimRun } from "../../api";

function run(over: Partial<SimRun> & { runId: string; startedAt: string }): SimRun {
  return {
    formatVersion: 2,
    sampleRateHz: 100,
    dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`,
    telemetryBytes: 1024,
    driver: "Driver",
    driverId: "d-1",
    session: null,
    track: "autocross",
    trackName: "Autocross 2026",
    finishedReason: "finished",
    profile: "wheel",
    device: null,
    physics: "native",
    simVersion: "0.1.0",
    synthetic: false,
    samples: 4100,
    assists: { traction: false, abs: false, autoShift: false },
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

// Relative to now, because the day headings are ("Today", "Yesterday", a date)
// and a fixture with fixed dates would drift into a different heading -- and a
// different number of groups -- depending on when the suite runs.
const ago = (days: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// Two days, so "everything is closed" is distinguishable from "the newest day
// is open", which is what this used to do.
const RUNS = [
  run({ runId: "today-a", startedAt: ago(0, 13), driver: "Nick" }),
  run({ runId: "today-b", startedAt: ago(0, 12), driver: "Sam" }),
  run({ runId: "older", startedAt: ago(7, 12), driver: "Alex" }),
];

const PROPS = {
  runs: RUNS,
  selectedId: null as string | null,
  onSelect: vi.fn(),
  onReplay: vi.fn(),
  onOpenInLogs: vi.fn(),
  canReplay: true,
  driverId: "d-1",
};

/** The clickable day headings: one per group, the first row of each tbody. */
const dayHeadings = (container: HTMLElement): HTMLTableRowElement[] =>
  [...container.querySelectorAll("tbody")]
    .map((b) => b.querySelector("tr"))
    .filter((r): r is HTMLTableRowElement => r != null);

describe("RunsTable", () => {
  // The table remembers how it was left between mounts (see `view`), which is
  // the point -- and would otherwise leak one test into the next.
  beforeEach(resetRunsView);

  it("opens with every day rolled up when none of the newest is yours", () => {
    const { container } = render(<RunsTable {...PROPS} driverId="someone-else" />);
    expect(screen.queryByText("Nick")).toBeNull();
    expect(screen.queryByText("Alex")).toBeNull();
    // Two days are still listed, and each says what is in it.
    const days = dayHeadings(container);
    expect(days).toHaveLength(2);
    expect(days[0]?.textContent).toContain("2 runs");
    expect(screen.getByRole("button", { name: /expand all/i })).toBeTruthy();
  });

  it("opens the day you click, and only that day", () => {
    const { container } = render(<RunsTable {...PROPS} driverId={null} />);
    fireEvent.click(dayHeadings(container)[0]!);
    expect(screen.getByText("Nick")).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    expect(screen.queryByText("Alex")).toBeNull();
  });

  it("expand all opens them, and then offers to collapse all", () => {
    render(<RunsTable {...PROPS} driverId="someone-else" />);
    fireEvent.click(screen.getByRole("button", { name: /expand all/i }));
    expect(screen.getByText("Nick")).toBeTruthy();
    expect(screen.getByText("Alex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /collapse all/i }));
    expect(screen.queryByText("Nick")).toBeNull();
    expect(screen.getByRole("button", { name: /expand all/i })).toBeTruthy();
  });

  it("names going off course among the reasons a run is not ranked", () => {
    // The footnote listed every reason but this one, which under format 3 is
    // the most common. A footnote that explains the asterisk with a list that
    // omits the usual cause is worse than none.
    const off = run({
      runId: "off", startedAt: ago(0, 14), driver: "Kim", formatVersion: 3,
      laps: [{ lap: 1, raw: 43, cones: 0, off: 1, total: 43, valid: false, sectors: [], startedAtS: 0 }],
      stats: { ...RUNS[0]!.stats, laps: 1, bestLapS: null, bestLapNumber: null, totalOffCourse: 1 },
    });
    render(<RunsTable {...PROPS} runs={[off, ...RUNS]} />);
    expect(screen.getByText("Kim")).toBeTruthy();
    // In the same words as the session card and the lap table, where the
    // time would be -- not a dash and an asterisk explained by a footnote.
    const cell = screen.getByText("off course");
    expect(cell.getAttribute("title")).toMatch(/went off course/);
  });

  it("reveals a run selected from somewhere else", () => {
    // The leaderboard and the end-of-session summary both do this: set the
    // selection and switch to this tab. Landing on a table where the selected
    // row is inside a closed day is the same as landing on the wrong tab.
    const { rerender } = render(<RunsTable {...PROPS} driverId="someone-else" />);
    expect(screen.queryByText("Alex")).toBeNull();
    rerender(<RunsTable {...PROPS} driverId="someone-else" selectedId="older" />);
    expect(screen.getByText("Alex")).toBeTruthy();
  });
});

describe("RunsTable for the driver who just drove", () => {
  beforeEach(resetRunsView);

  it("opens the newest day by itself when some of it is yours, once", () => {
    const { container, unmount } = render(<RunsTable {...PROPS} />);
    // d-1 drove today: today is open, last week is not.
    expect(screen.getByText("Nick")).toBeTruthy();
    expect(screen.queryByText("Alex")).toBeNull();
    // Closed by hand, it stays closed -- across a remount too.
    fireEvent.click(dayHeadings(container)[0]!);
    expect(screen.queryByText("Nick")).toBeNull();
    unmount();
    render(<RunsTable {...PROPS} />);
    expect(screen.queryByText("Nick")).toBeNull();
  });

  it("opens a run from the keyboard", () => {
    const onSelect = vi.fn();
    render(<RunsTable {...PROPS} onSelect={onSelect} />);
    const row = screen.getByText("Nick").closest("tr")!;
    expect(row.tabIndex).toBe(0);
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ runId: "today-a" }));
  });

  it("shows why a run is unranked on the row, not only on hover", () => {
    // A current run, so traction control is the one thing wrong with it.
    const tc = run({
      runId: "tc", startedAt: ago(0, 15), driver: "Pat", formatVersion: 3, simVersion: "0.7.5",
      stats: { ...RUNS[0]!.stats, vehicleModel: 2 },
      assists: { traction: true, abs: false, autoShift: false },
    });
    render(<RunsTable {...PROPS} runs={[tc, ...RUNS]} />);
    const chip = within(screen.getByText("Pat").closest("tr")!).getByTestId("unranked-chip");
    expect(chip.textContent).toBe("TC on");
    expect(chip.getAttribute("title")).toMatch(/traction control was on/);
  });

  it("gives each course its own best on the day header", () => {
    const accel = run({
      runId: "acc", startedAt: ago(0, 9), track: "accel", trackName: "Acceleration",
      stats: { ...RUNS[0]!.stats, bestLapS: 4.352 },
    });
    const { container } = render(<RunsTable {...PROPS} runs={[accel, ...RUNS]} />);
    const bests = container.querySelector("[data-testid=day-bests]")!;
    // Two autocross runs at 41.2 and one accel run: not "4.352" as the day's best.
    expect(bests.textContent).toBe("AX 41.200 · Accel 4.352");
  });
});
