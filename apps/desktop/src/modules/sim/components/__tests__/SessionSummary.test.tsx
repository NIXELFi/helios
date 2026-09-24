/* The card that comes up when the simulator closes. It answers "how did that
 * go", so what it compares a lap with has to be what the board compares it
 * with -- the same course, car, device and physics -- and it must not tell a
 * teammate at a shared rig about "your" best. */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { SessionSummary } from "../SessionSummary";
import type { SimRun } from "../../api";

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`, telemetryBytes: 1024,
    driver: "Nick", driverId: "d-1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-22T17:22:00Z", finishedReason: "finished", profile: "wheel",
    detectedInput: "wheel", device: null, physics: "native", simVersion: "0.7.5",
    synthetic: false, samples: 4100, assists: { traction: false, abs: false, autoShift: false },
    laps: [],
    ...over,
    stats: {
      durationS: 41, distanceM: 685, laps: 1, bestLapS: 41.2, bestLapRawS: 41.2,
      bestLapNumber: 1, bestSectors: [], theoreticalBestS: null, totalCones: 0,
      totalOffCourse: 0, peakSpeedKph: 90, peakRpm: 12000, peakLatG: 1.4,
      peakBrakeG: 1.3, peakAccelG: 1.1, avgSpeedMps: 16, fullThrottleFrac: 0.3,
      brakingFrac: 0.2, offTrackS: 0, ffbClippedFrac: 0, vehicleModel: 2,
      ...over.stats,
    },
  } as SimRun;
}

const at = (h: number, m = 0) => `2026-09-22T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const st = (t: number, extra: Record<string, unknown> = {}) => ({ bestLapS: t, bestLapRawS: t, ...extra }) as never;
const session = { startedAtMs: Date.parse(at(17)), endedAtMs: Date.parse(at(18)) };
const base = { session, canReplay: true, onOpenRun: vi.fn(), onReplay: vi.fn(), onClose: vi.fn() };

describe("SessionSummary", () => {
  const before = [
    run({ runId: "old-bike", startedAt: at(9), stats: st(40.5) }),
    run({ runId: "jordan", driver: "Jordan", driverId: "d-2", startedAt: at(10), stats: st(38.4) }),
    // A quicker lap on the 4-wheel model: another board, so not "your best".
    run({ runId: "old-four", startedAt: at(11), stats: st(37, { vehicleModel: 3, physicsRev: 2 }) }),
  ];
  const now = [
    run({ runId: "s1", startedAt: at(17, 5), stats: st(41) }),
    run({ runId: "s2", startedAt: at(17, 10), stats: st(40.1) }),
    run({ runId: "acc", track: "accel", trackName: "Acceleration", startedAt: at(17, 20), stats: st(4.352) }),
  ];
  const allRuns = [...before, ...now];

  it("heads with the busiest course's best, compared on its own board", () => {
    render(<SessionSummary {...base} runs={now} allRuns={allRuns} viewerId="d-1" />);
    // Not the 4.352 accel run, which is shorter, not quicker.
    expect(screen.getAllByText("40.100")[0]!.className).toMatch(/text-xl/);
    expect(screen.getByText(/Best this session · Autocross/)).toBeTruthy();
    expect(screen.getByText(/0\.400 s quicker than your previous best on this board/)).toBeTruthy();
    expect(screen.getByTestId("session-board-line").textContent).toMatch(/P2 on Autocross · Bicycle · Wheel, \+1\.700 to Jordan/);
    expect(screen.getByTestId("session-other-courses").textContent).toMatch(/Accel 4\.352/);
  });

  it("does not say \"your\" to somebody who is not the driver", () => {
    render(<SessionSummary {...base} runs={now} allRuns={allRuns} viewerId="d-2" />);
    expect(screen.getByText(/quicker than Nick's previous best on this board/)).toBeTruthy();
    expect(screen.getByTestId("session-board-line").textContent).toMatch(/to you$/);
  });

  it("calls a lap that tops its board the team record", () => {
    const fast = [run({ runId: "s3", startedAt: at(17, 30), stats: st(38) })];
    render(<SessionSummary {...base} runs={fast} allRuns={[...before, ...fast]} viewerId="d-1" />);
    expect(screen.getByTestId("session-board-line").textContent).toMatch(/Team record.*on Autocross · Bicycle · Wheel/i);
  });

  it("does not wrap the time of day", () => {
    render(<SessionSummary {...base} runs={now} allRuns={allRuns} viewerId="d-1" />);
    const time = screen.getAllByRole("button").find((b) => /4\.352/.test(b.textContent ?? ""))!.querySelector("span")!;
    expect(time.className).toMatch(/whitespace-nowrap/);
  });
});
