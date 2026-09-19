/* What the leaderboard says about its own rule.
 *
 * The scoring changed under it -- a lap that went off course stopped having
 * a time at all -- and the tooltip went on describing the old rule, with the
 * old number, as "what an event scores". It was neither what an event scores
 * (FSAE adds twenty seconds, not ten, and keeps the time) nor what this board
 * does. A tooltip explaining the wrong rule is worse than no tooltip. */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Leaderboard } from "../Leaderboard";
import type { SimRun } from "../../api";

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`, telemetryBytes: 1024,
    driver: "Nick", driverId: "d-1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-19T10:00:00Z", finishedReason: "finished", profile: "wheel",
    detectedInput: "wheel", device: null, physics: "native", simVersion: "0.3.0",
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
    const title = screen.getByText("Best lap anyone has scored").getAttribute("title") ?? "";
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
});
