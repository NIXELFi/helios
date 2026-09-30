/* Sharing runs with the team.
 *
 * Two things here carry real consequences. `rowToRun` decides that a
 * teammate's run is the same shape as one of your own, which is what lets the
 * runs table, the leaderboard and `isRankable` treat it identically -- and
 * getting a field wrong there produces a run that looks fine and ranks wrong.
 * `telemetryToKeep` decides what KEEPS its telemetry, which is the difference
 * between a bucket that is bounded and one that grows for as long as the team
 * practises. */
import { describe, it, expect } from "vitest";

import {
  GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT,
  rowStamp, rowToRun, telemetryToKeep, thinCsv,
} from "../share";
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
    detectedInput: "wheel",
    device: null,
    physics: "native",
    simVersion: "0.6.0",
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
    profile: "wheel",
    detected_input: "wheel",
    stats: { peakLatG: 1.55, theoreticalBestS: 40.1, bestSectors: [13.2, 14.0, 13.7], simVersion: "0.6.0" },
    laps_detail: [{ lap: 1, raw: 40.9, cones: 0, off: 0, total: 40.9, sectors: [], startedAtS: 0 }],
    telemetry_object: "u-ralf/20260919-100000-autocross-ab12.csv",
    telemetry_bytes: 1_100_000,
    evicted_at: null,
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

  it("carries the sample count, and admits when a row has none", () => {
    // The detail panel used to show "Samples 0 at 99 Hz" for every shared
    // run, and importing one wrote that zero into the local manifest.
    expect(rowToRun(row({ stats: { samples: 3963 } })).samples).toBe(3963);
    expect(rowToRun(row({ stats: {} })).samples).toBe(0);
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

describe("what keeps its telemetry", () => {
  const at = (h: number) => `2026-09-19T${String(h).padStart(2, "0")}:00:00Z`;
  const r = (id: string, best: number | null, hour: number, over: Partial<SimRun> = {}) =>
    localRun({
      runId: id, startedAt: at(hour),
      stats: { ...localRun({ runId: "x" }).stats, bestLapS: best, laps: best == null ? 1 : 1 },
      ...over,
    });

  it("keeps the best three and the most recent three, per course", () => {
    const runs = [
      r("a", 44, 1), r("b", 41, 2), r("c", 43, 3), r("d", 42, 4), r("e", 45, 5), r("f", 46, 6),
    ];
    // best 3 by time: b (41), d (42), c (43). recent 3 by clock: f, e, d.
    expect(telemetryToKeep(runs, "me")).toEqual(new Set(["b", "d", "c", "f", "e"]));
    expect(KEEP_BEST).toBe(3);
    expect(KEEP_RECENT).toBe(3);
  });

  it("is a union, so a new personal best does not cost two slots", () => {
    // The newest run is also the quickest -- it is in both lists and counts once.
    const runs = [r("old", 44, 1), r("mid", 43, 2), r("pb", 40, 3)];
    expect(telemetryToKeep(runs, "me")).toEqual(new Set(["old", "mid", "pb"]));
  });

  it("counts each course separately", () => {
    const runs = [
      r("ax1", 41, 1), r("ax2", 42, 2),
      r("en1", 130, 3, { track: "endurance" }), r("en2", 131, 4, { track: "endurance" }),
    ];
    const keep = telemetryToKeep(runs, "me");
    expect(keep).toEqual(new Set(["ax1", "ax2", "en1", "en2"]));
  });

  it("will not let an unranked lap be a BEST, but will let it be recent", () => {
    // A lap with traction control on is not a benchmark. It is still the last
    // thing you drove, and the lap you threw away is often the one to watch.
    const runs = [
      r("clean", 44, 1),
      r("assisted", 38, 2, { assists: { traction: true, abs: false, autoShift: false } }),
    ];
    const keep = telemetryToKeep(runs, "me");
    expect(keep.has("clean")).toBe(true);
    expect(keep.has("assisted")).toBe(true);
    // ...and it did not take the best slot: ordering is by ranked time, and
    // only `clean` is ranked at all.
    const onlyBest = telemetryToKeep([r("clean", 44, 1), r("a2", 38, 2, {
      assists: { traction: true, abs: false, autoShift: false },
    }), r("a3", 39, 3, { assists: { traction: true, abs: false, autoShift: false } }),
      r("a4", 39.5, 4, { assists: { traction: true, abs: false, autoShift: false } })], "me");
    // recent 3 = a4, a3, a2; best 3 (ranked only) = clean. So clean survives
    // despite being the oldest and slowest, because it is the only real time.
    expect(onlyBest.has("clean")).toBe(true);
  });

  it("ignores the robot, other people, and runs with no lap", () => {
    // Not, any more, a run of yours that is only on the server: the rule is
    // about a driver, not a machine, and skipping those is how a laptop with
    // one run came to delete everything the rig had shared. See
    // `share-sync.test.ts`.
    const runs = [
      r("mine", 41, 5),
      r("robot", 37, 6, { synthetic: true }),
      r("theirs", 38, 7, { driverId: "someone-else" }),
      r("theirs-shared", 39, 8, { driverId: "someone-else", remote: true }),
      localRun({ runId: "nolap", startedAt: at(9),
        stats: { ...localRun({ runId: "x" }).stats, bestLapS: null, laps: 0 } }),
    ];
    expect(telemetryToKeep(runs, "me")).toEqual(new Set(["mine"]));
  });

  it("has nothing to say about an empty archive", () => {
    expect(telemetryToKeep([], "me").size).toBe(0);
  });

  it("is bounded by the two constants, whatever the driver does", () => {
    const many = Array.from({ length: 40 }, (_, i) => r(`r${i}`, 40 + i, i % 24));
    expect(telemetryToKeep(many, "me").size).toBeLessThanOrEqual(KEEP_BEST + KEEP_RECENT);
  });

  it("keeps only the best two and the latest one on a generated course", () => {
    const g = (id: string, best: number, hour: number) =>
      r(id, best, hour, { track: "gen-ax-K7Q2", trackName: "Generated autocross K7Q2" });
    const runs = [g("a", 44, 1), g("b", 41, 2), g("c", 43, 3), g("d", 42, 4), g("e", 45, 5)];
    // best 2 by time: b (41), d (42). recent 1 by clock: e.
    expect(telemetryToKeep(runs, "me")).toEqual(new Set(["b", "d", "e"]));
    expect(GEN_KEEP_BEST).toBe(2);
    expect(GEN_KEEP_RECENT).toBe(1);
  });

  it("applies the fixed rule and the generated rule side by side", () => {
    const runs = [
      r("ax1", 41, 1), r("ax2", 42, 2), r("ax3", 43, 3), r("ax4", 44, 4),
      r("g1", 51, 5, { track: "gen-en-QYUQ" }), r("g2", 52, 6, { track: "gen-en-QYUQ" }),
      r("g3", 53, 7, { track: "gen-en-QYUQ" }), r("g4", 54, 8, { track: "gen-en-QYUQ" }),
    ];
    const keep = telemetryToKeep(runs, "me");
    // autocross: best 3 = ax1, ax2, ax3; recent 3 = ax4, ax3, ax2 -- all four.
    expect(keep.has("ax1")).toBe(true);
    expect(keep.has("ax4")).toBe(true);
    // generated: best 2 = g1, g2; recent 1 = g4. g3 is in neither.
    expect(keep.has("g1")).toBe(true);
    expect(keep.has("g2")).toBe(true);
    expect(keep.has("g4")).toBe(true);
    expect(keep.has("g3")).toBe(false);
  });

  it("is bounded by the generated constants on a generated course", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      r(`r${i}`, 40 + i, i % 24, { track: "gen-ax-ZZZZ" }));
    expect(telemetryToKeep(many, "me").size).toBeLessThanOrEqual(GEN_KEEP_BEST + GEN_KEEP_RECENT);
  });
});

describe("thinning a non-wheel run", () => {
  const csv = (rows: number) =>
    ["time_s,a,b", ...Array.from({ length: rows }, (_, i) => `${(i / 100).toFixed(3)},${i},${i * 2}`)]
      .join("\n") + "\n";

  it("keeps one row in ten going 100 Hz to 10 Hz", () => {
    const out = thinCsv(csv(100), 100, 10);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("time_s,a,b");          // header survives
    expect(lines.length - 1).toBe(10);
  });

  it("keeps the shape, not just the count", () => {
    const lines = thinCsv(csv(50), 100, 10).trimEnd().split("\n");
    // Every kept row is a whole row, and the first sample is still the first.
    expect(lines[1]).toBe("0.000,0,0");
    expect(lines.every((l) => l.split(",").length === 3)).toBe(true);
  });

  it("does nothing when the file is already at or below the target", () => {
    const at10 = csv(20);
    expect(thinCsv(at10, 10, 10)).toBe(at10);
    expect(thinCsv(at10, 5, 10)).toBe(at10);
  });

  it("survives a file with nothing in it but a header", () => {
    expect(thinCsv("time_s,a\n", 100, 10)).toBe("time_s,a\n");
  });
});

// A run is pushed once and then, for the rest of its life, only ever read
// back. That was fine until a column was added: `profile` and
// `detected_input` went into the table and every run the team had already
// driven stayed null, which put all of them on the "Unrecorded device" board
// and left the wheel board -- the one everybody was on -- empty.
//
// `rowStamp` is what decides a row is out of date and has to go up again. It
// has to notice a real change and, just as importantly, not notice anything
// else: re-pushing every run on every sign-in would rewrite hundreds of rows
// to change nothing, which is how the previous version of this ended up
// skipping them all.
describe("noticing that a shared row has gone stale", () => {
  const server = (over: Record<string, unknown> = {}) => ({
    profile: null, detected_input: null, format_version: 2, best_lap_s: 41.2, ...over,
  } as Parameters<typeof rowStamp>[0]);

  it("says nothing changed when nothing changed", () => {
    expect(rowStamp(server())).toBe(rowStamp(server()));
  });

  it("notices a column that was added after the run was pushed", () => {
    expect(rowStamp(server())).not.toBe(rowStamp(server({ profile: "wheel" })));
    expect(rowStamp(server())).not.toBe(rowStamp(server({ detected_input: "wheel" })));
  });

  it("notices a manifest re-read under a newer format", () => {
    // Format 3 is where an off-course lap stopped scoring, so a run re-read
    // under it can have a different best lap than the one on the server.
    expect(rowStamp(server())).not.toBe(rowStamp(server({ format_version: 3 })));
  });

  it("notices the time itself moving", () => {
    expect(rowStamp(server())).not.toBe(rowStamp(server({ best_lap_s: 40.9 })));
    // A run whose only valid lap was thrown out has no time at all any more.
    expect(rowStamp(server())).not.toBe(rowStamp(server({ best_lap_s: null })));
  });

  it("does not confuse an absent field with an empty one", () => {
    // "" and null both mean "nothing here", and treating them as different
    // would re-push every row forever without changing anything.
    expect(rowStamp(server({ profile: null }))).toBe(rowStamp(server({ profile: "" })));
  });

  it("does not run two fields together", () => {
    // A separator that can appear inside a value makes ("a|b", "") and
    // ("a", "b|") the same row, which is a stale row that never updates.
    expect(rowStamp(server({ profile: "wheel", detected_input: "" })))
      .not.toBe(rowStamp(server({ profile: "wheel|", detected_input: "" })));
  });
});

describe("telemetryToKeep per model (5.12.2)", () => {
  it("a driver's 4-wheel laps do not push their bicycle bests out", () => {
    const mk = (id: string, best: number, vm: number) => ({
      runId: id, driverId: "me", track: "autocross", trackName: "AX", synthetic: false, simVersion: "0.7.4",
      startedAt: `2026-09-2${id.length}T10:00:00Z`, assists: { traction: false, abs: false, autoShift: false },
      laps: [], stats: { laps: 1, bestLapS: best, bestLapRawS: best, totalCones: 0, vehicleModel: vm, physicsRev: vm === 3 ? 2 : 1 },
      formatVersion: 2, telemetryBytes: 1000,
    }) as never;
    const runs = [mk("b1", 44, 2), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(`f${i}`, 40 - i * 0.1, 3))];
    expect(telemetryToKeep(runs, "me").has("b1")).toBe(true);
  });
});

describe("rowStamp and sector cones (5.12.3)", () => {
  it("a row shared without its per-sector cones is re-shared once they are there", () => {
    const base = { profile: "wheel", detected_input: "wheel", format_version: 4, best_lap_s: 40, stats: { vehicleModel: 2, counted: true } };
    const server = rowStamp({ ...base, laps_detail: [{ lap: 1, sectors: [20, 20] }] });
    const local = rowStamp({ ...base, laps_detail: [{ lap: 1, sectors: [20, 20], sectorCones: [0, 1] }] });
    expect(local).not.toBe(server);
    expect(rowStamp({ ...base, laps_detail: [{ lap: 1, sectors: [20, 20], sectorCones: [0, 1] }] })).toBe(local);
  });
});
