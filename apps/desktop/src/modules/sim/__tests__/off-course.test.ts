/* A lap that left the course does not go on the board.
 *
 * Stricter than FSAE, which adds 20 s and keeps the time. The reason is not
 * that the rulebook is wrong -- at a competition an off course is seen,
 * marshalled and re-run -- but that this is a board people practise against
 * with nobody watching, where cutting a corner has no consequence except the
 * time it saves.
 *
 * The simulator stopped filing such laps as times at manifest version 3, so
 * for a new run this holds by construction. These cover the backstop, which
 * is the archive recorded under the old +10 s rule and still sitting on
 * everyone's disk. */
import { describe, it, expect } from "vitest";

import {
  bestLapWentOffCourse, hasTrustworthySectors, isRankable, unrankedReason,
  type SimLap, type SimRun,
} from "../api";

function lap(over: Partial<SimLap> & { lap: number }): SimLap {
  return { raw: 41, cones: 0, off: 0, total: 41, sectors: [], startedAtS: 0, ...over };
}

function run(over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3,
    sampleRateHz: 100,
    runId: "r1", dir: "C:/r1", telemetryPath: "C:/r1/t.csv", telemetryBytes: 10,
    driver: "Nick", driverId: "u1", session: null,
    track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-19T10:00:00Z", finishedReason: "finished",
    profile: "wheel", device: null, physics: "native", simVersion: "0.6.0",
    synthetic: false, samples: 4100,
    assists: { traction: false, abs: false, autoShift: false },
    laps: [lap({ lap: 1 })],
    stats: {
      durationS: 41, distanceM: 685, laps: 1, bestLapS: 41, bestLapRawS: 41,
      bestLapNumber: 1, bestSectors: [], theoreticalBestS: null, totalCones: 0,
      totalOffCourse: 0, peakSpeedKph: 90, peakRpm: 12000, peakLatG: 1.4,
      peakBrakeG: 1.3, peakAccelG: 1.1, avgSpeedMps: 16, fullThrottleFrac: 0.3,
      brakingFrac: 0.2, offTrackS: 0, ffbClippedFrac: 0,
    },
    ...over,
  } as SimRun;
}

describe("a lap that left the course", () => {
  it("does not rank", () => {
    const off = run({
      laps: [lap({ lap: 1, off: 1 })],
      stats: { ...run().stats, totalOffCourse: 1 },
    });
    expect(bestLapWentOffCourse(off)).toBe(true);
    expect(isRankable(off)).toBe(false);
    expect(unrankedReason(off)).toBe("that lap went off course");
  });

  it("is why a run whose ONLY lap went off is unranked -- not 'no completed lap'", () => {
    // Exactly the shape the simulator writes since format 3, and three real
    // runs in the archive have it: one completed lap, thrown out, so no best
    // lap number and no time. Testing for the time first reported the one
    // thing definitely not true of it.
    const thrownOut = run({
      laps: [lap({ lap: 1, off: 1, raw: 43.329, cones: 8, total: 59.329, valid: false })],
      stats: { ...run().stats, laps: 1, bestLapS: null, bestLapRawS: null, bestLapNumber: null, totalOffCourse: 1 },
    });
    expect(isRankable(thrownOut)).toBe(false);
    expect(unrankedReason(thrownOut)).toBe("that lap went off course");
    // ...and a run that genuinely never finished a lap still says so.
    const never = run({ laps: [], stats: { ...run().stats, laps: 0, bestLapS: null, bestLapNumber: null } });
    expect(unrankedReason(never)).toBe("no completed lap");
  });

  it("does not stop the CLEAN laps of the same run ranking", () => {
    // Endurance: one excursion on lap 2 must not throw away lap 3, which is
    // the lap the run is actually ranked on.
    const mixed = run({
      laps: [lap({ lap: 1, raw: 62, total: 62 }), lap({ lap: 2, off: 1 }), lap({ lap: 3, raw: 60, total: 60 })],
      stats: { ...run().stats, laps: 3, bestLapS: 60, bestLapNumber: 3, totalOffCourse: 1 },
    });
    expect(bestLapWentOffCourse(mixed)).toBe(false);
    expect(isRankable(mixed)).toBe(true);
  });

  it("is caught on an old run with no per-lap detail", () => {
    // A shared row, or a manifest from before the lap array carried `off`.
    // Exact on autocross, which is one lap; cautious on endurance, which is
    // the right way round to be wrong.
    const bare = run({ laps: [], stats: { ...run().stats, totalOffCourse: 1, bestLapNumber: null } });
    expect(bestLapWentOffCourse(bare)).toBe(true);
    expect(isRankable(bare)).toBe(false);
  });

  it("leaves a clean run alone", () => {
    expect(bestLapWentOffCourse(run())).toBe(false);
    expect(isRankable(run())).toBe(true);
    expect(unrankedReason(run())).toBeNull();
  });
});

describe("sectors can only be believed when they were driven on the course", () => {
  it("trusts a version 3 run whatever it did", () => {
    // Version 3 excludes invalid laps at the source, so even a run that went
    // off has honest sector bests.
    const v3 = run({ formatVersion: 3, stats: { ...run().stats, totalOffCourse: 2 } });
    expect(hasTrustworthySectors(v3)).toBe(true);
  });

  it("trusts a version 2 run that never left the course", () => {
    const clean = run({ formatVersion: 2, stats: { ...run().stats, totalOffCourse: 0 } });
    expect(hasTrustworthySectors(clean)).toBe(true);
  });

  it("does not trust a version 2 run that did", () => {
    // Its sector bests can be made of pieces driven off the course, and a
    // theoretical best built from them is a lap nobody could legally drive.
    const off = run({ formatVersion: 2, stats: { ...run().stats, totalOffCourse: 1 } });
    expect(hasTrustworthySectors(off)).toBe(false);
  });

  it("never trusts version 1, whose sectors are not sector times at all", () => {
    expect(hasTrustworthySectors(run({ formatVersion: 1 }))).toBe(false);
    expect(hasTrustworthySectors(
      run({ formatVersion: 1, stats: { ...run().stats, totalOffCourse: 0 } }),
    )).toBe(false);
  });
});
