/* The runs table is the whole team's archive, so how much of it is on screen
 * at once is a real decision and not a styling detail. These cover the two
 * halves of it: nothing is open until you ask, and anything picked somewhere
 * else opens itself so you are not staring at a table with no visible
 * selection. */
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("opens with every day rolled up", () => {
    const { container } = render(<RunsTable {...PROPS} />);
    expect(screen.queryByText("Nick")).toBeNull();
    expect(screen.queryByText("Alex")).toBeNull();
    // Two days are still listed, and each says what is in it.
    const days = dayHeadings(container);
    expect(days).toHaveLength(2);
    expect(days[0]?.textContent).toContain("2 runs");
    expect(screen.getByRole("button", { name: /expand all/i })).toBeTruthy();
  });

  it("opens the day you click, and only that day", () => {
    const { container } = render(<RunsTable {...PROPS} />);
    fireEvent.click(dayHeadings(container)[0]!);
    expect(screen.getByText("Nick")).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    expect(screen.queryByText("Alex")).toBeNull();
  });

  it("expand all opens them, and then offers to collapse all", () => {
    render(<RunsTable {...PROPS} />);
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
    const { container } = render(<RunsTable {...PROPS} runs={[off, ...RUNS]} />);
    fireEvent.click(dayHeadings(container)[0]!);
    expect(screen.getByText("Kim")).toBeTruthy();
    const note = screen.getByText(/not ranked —/);
    expect(note.textContent).toMatch(/went off course/);
  });

  it("reveals a run selected from somewhere else", () => {
    // The leaderboard and the end-of-session summary both do this: set the
    // selection and switch to this tab. Landing on a table where the selected
    // row is inside a closed day is the same as landing on the wrong tab.
    const { rerender } = render(<RunsTable {...PROPS} />);
    expect(screen.queryByText("Alex")).toBeNull();
    rerender(<RunsTable {...PROPS} selectedId="older" />);
    expect(screen.getByText("Alex")).toBeTruthy();
  });
});
