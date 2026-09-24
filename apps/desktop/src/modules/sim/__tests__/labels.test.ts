/* The short words the module puts where a sentence will not fit: the unranked
 * chip in the runs table, the "Ended" row, the sync pill. Each must agree with
 * the sentence it abbreviates. */
import { describe, expect, it } from "vitest";
import { finishedText, unrankedReason, unrankedShort, type SimRun } from "../api";
import { fmtAgo } from "../components/SyncPill";

function run(over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, runId: "r", dir: "", telemetryPath: "", telemetryBytes: 1,
    driver: "Nick", driverId: "d-1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-22T10:00:00Z", finishedReason: "finished", profile: "wheel", detectedInput: "wheel",
    device: null, physics: "native", simVersion: "0.7.5", synthetic: false, samples: 1,
    assists: { traction: false, abs: false, autoShift: false }, laps: [],
    ...over,
    stats: {
      durationS: 41, distanceM: 685, laps: 1, bestLapS: 41, bestLapRawS: 41, bestLapNumber: 1, bestSectors: [],
      theoreticalBestS: null, totalCones: 0, totalOffCourse: 0, peakSpeedKph: 90, peakRpm: 1, peakLatG: 1,
      peakBrakeG: 1, peakAccelG: 1, avgSpeedMps: 1, fullThrottleFrac: 0, brakingFrac: 0, offTrackS: 0,
      ffbClippedFrac: 0, vehicleModel: 2,
      ...over.stats,
    },
  } as SimRun;
}

describe("unrankedShort", () => {
  it("is null exactly when the run ranks", () => {
    expect(unrankedShort(run())).toBeNull();
    expect(unrankedReason(run())).toBeNull();
  });

  it("names the same reason as the sentence, in a word or two", () => {
    const cases: [Partial<SimRun>, string, RegExp][] = [
      [{ synthetic: true }, "robot", /robot/],
      [{ driverId: null }, "unverified", /unverified/],
      [{ assists: { traction: true, abs: true, autoShift: false } }, "TC+ABS on", /traction control, ABS was on/],
      [{ simVersion: "0.5.0" }, "old course", /driven before/],
      [{
        laps: [{ lap: 1, raw: 43, cones: 0, off: 1, total: 43, valid: false, sectors: [], startedAtS: 0 }],
        stats: { bestLapS: null, bestLapNumber: null, totalOffCourse: 1 } as never,
      }, "off course", /off course/],
    ];
    for (const [over, short, sentence] of cases) {
      const r = run(over);
      expect(unrankedShort(r)).toBe(short);
      expect(unrankedReason(r)).toMatch(sentence);
    }
  });
});

describe("finishedText", () => {
  it("says how a run ended in words, and passes an unknown reason through", () => {
    expect(finishedText("window-closed")).toBe("Closed the simulator");
    expect(finishedText("restarted")).toBe("Restarted");
    expect(finishedText(null)).toBe("—");
    expect(finishedText("something-new")).toBe("something-new");
  });
});

describe("fmtAgo", () => {
  it("rounds to what a person would say", () => {
    const t = Date.parse("2026-09-22T10:00:00Z");
    expect(fmtAgo(t, t + 10_000)).toBe("just now");
    expect(fmtAgo(t, t + 2 * 60_000)).toBe("2 min ago");
    expect(fmtAgo(t, t + 3 * 3_600_000)).toBe("3 h ago");
    expect(fmtAgo(t, t + 50 * 3_600_000)).toBe("2 days ago");
  });
});
