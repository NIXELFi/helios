/* Sharing runs with the team.
 *
 * Two things here carry real consequences. `rowToRun` decides that a
 * teammate's run is the same shape as one of your own, which is what lets the
 * runs table, the leaderboard and `isRankable` treat it identically -- and
 * getting a field wrong there produces a run that looks fine and ranks wrong.
 * `telemetryWorthSharing` decides what gets uploaded, which is the difference
 * between a few hundred kilobytes a session and a few hundred megabytes. */
import { describe, it, expect } from "vitest";

import { rowToRun, telemetryWorthSharing } from "../share";
import { isRankable, runBest, type SimRun } from "../../api";

function localRun(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 2,
    sampleRateHz: 100,
    dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`,
    telemetryBytes: 1024,
    driver: "Nick",
    driverId: "me",
    session: null,
    track: "autocross",
    trackName: "Autocross 2026",
    startedAt: "2026-09-19T10:00:00Z",
    finishedReason: "finished",
    profile: "wheel",
    device: null,
    physics: "native",
    simVersion: "0.2.0",
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

/** A row as PostgREST hands it back. */
function row(over: Record<string, unknown> = {}) {
  return {
    run_id: "20260919-100000-autocross-ab12",
    user_id: "u-ralf",
    display_name: "Ralf Weber",
    subteam: "Chassis",
    driver: "Ralf Weber",
    track: "autocross",
    track_name: "Autocross 2026",
    started_at: "2026-09-19T10:00:00Z",
    best_lap_s: 40.9,
    laps: 2,
    total_cones: 1,
    assists: { traction: false, abs: false, autoShift: false },
    synthetic: false,
    format_version: 2,
    stats: { peakLatG: 1.55, theoreticalBestS: 40.1, bestSectors: [13.2, 14.0, 13.7] },
    laps_detail: [{ lap: 1, raw: 40.9, cones: 0, off: 0, total: 40.9, sectors: [], startedAtS: 0 }],
    telemetry_object: "u-ralf/20260919-100000-autocross-ab12.csv",
    telemetry_bytes: 1_100_000,
    ...over,
  } as Parameters<typeof rowToRun>[0];
}

describe("a shared row becomes a run", () => {
  it("keeps the times and stats the boards read", () => {
    const r = rowToRun(row());
    expect(runBest(r)).toBe(40.9);
    expect(r.stats.laps).toBe(2);
    expect(r.stats.totalCones).toBe(1);
    // Everything else the manifest carried survives the round trip.
    expect(r.stats.peakLatG).toBe(1.55);
    expect(r.stats.theoreticalBestS).toBe(40.1);
    expect(r.laps).toHaveLength(1);
  });

  it("is marked as not being on this machine", () => {
    const r = rowToRun(row());
    expect(r.remote).toBe(true);
    // The two fields every "can I open this locally" check keys off.
    expect(r.dir).toBe("");
    expect(r.telemetryPath).toBe("");
    expect(r.telemetryObject).toBe("u-ralf/20260919-100000-autocross-ab12.csv");
  });

  it("ranks by the same rule as a local run", () => {
    expect(isRankable(rowToRun(row()))).toBe(true);
    // The aids are why most unranked runs are unranked, and they have to
    // survive the trip or a teammate's assisted lap tops the board.
    expect(isRankable(rowToRun(row({ assists: { traction: true } })))).toBe(false);
    expect(isRankable(rowToRun(row({ synthetic: true })))).toBe(false);
    expect(isRankable(rowToRun(row({ best_lap_s: null })))).toBe(false);
  });

  it("survives a row with nothing optional in it", () => {
    // An older simulator, or a run filed before a field existed.
    const r = rowToRun(row({
      stats: null, laps_detail: null, assists: null, track_name: null,
      display_name: null, driver: null, telemetry_object: null, telemetry_bytes: null,
    }));
    expect(r.trackName).toBe("autocross");
    expect(r.driver).toBe("Unknown");
    expect(r.laps).toEqual([]);
    expect(r.assists).toEqual({ traction: false, abs: false, autoShift: false });
    expect(r.telemetryObject).toBeNull();
  });
});

describe("what is worth uploading", () => {
  it("is the best ranked lap on each course, and nothing else", () => {
    const runs = [
      localRun({ runId: "ax-slow", stats: { ...localRun({ runId: "x" }).stats, bestLapS: 44 } }),
      localRun({ runId: "ax-best", stats: { ...localRun({ runId: "x" }).stats, bestLapS: 41 } }),
      localRun({ runId: "ax-mid", stats: { ...localRun({ runId: "x" }).stats, bestLapS: 42 } }),
      localRun({ runId: "end-best", track: "endurance",
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: 60 } }),
    ];
    expect(telemetryWorthSharing(runs, "me")).toEqual(new Set(["ax-best", "end-best"]));
  });

  it("ignores runs that cannot rank", () => {
    // A quicker lap with traction control on must not become the lap the team
    // watches, because it is not a lap the team can be compared against.
    const runs = [
      localRun({ runId: "assisted", assists: { traction: true, abs: false, autoShift: false },
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: 38 } }),
      localRun({ runId: "clean", stats: { ...localRun({ runId: "x" }).stats, bestLapS: 41 } }),
      localRun({ runId: "robot", synthetic: true,
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: 37 } }),
      localRun({ runId: "nolap", stats: { ...localRun({ runId: "x" }).stats, bestLapS: null } }),
    ];
    expect(telemetryWorthSharing(runs, "me")).toEqual(new Set(["clean"]));
  });

  it("ignores other people's runs, and ones already shared", () => {
    // A shared rig holds everybody's drives. Uploading somebody else's would
    // file their lap under your name -- the database would let you.
    const runs = [
      localRun({ runId: "theirs", driverId: "someone-else",
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: 39 } }),
      localRun({ runId: "already-shared", remote: true,
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: 38 } }),
      localRun({ runId: "mine", stats: { ...localRun({ runId: "x" }).stats, bestLapS: 41 } }),
    ];
    expect(telemetryWorthSharing(runs, "me")).toEqual(new Set(["mine"]));
  });

  it("has nothing to say when nothing ranks", () => {
    const runs = [localRun({ runId: "nolap", stats: { ...localRun({ runId: "x" }).stats, bestLapS: null } })];
    expect(telemetryWorthSharing(runs, "me").size).toBe(0);
  });
});
