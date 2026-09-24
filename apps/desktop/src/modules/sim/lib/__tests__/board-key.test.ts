/* Everything that says "P3", "your best" or "a new record" about a run has
 * to mean the board the Leaderboard actually draws: course, car model, device
 * class and physics era. These pin the helpers that answer those questions
 * outside the Leaderboard itself -- the run panel, the session card, the ghost
 * picker, the day headers and the records strip. */
import { describe, expect, it } from "vitest";
import {
  bestPerCourse, bestWatchable, boardKeyOf, boardLabel, boardStanding, buildImprovements, buildRecentRecords,
  courseName, courseShort, ghostCandidates, lapCounts, leaderWatchable, sessionResult,
} from "../leaderboard";
import type { SimRun } from "../../api";

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    dir: "/runs/" + over.runId,
    telemetryPath: "/runs/" + over.runId + "/telemetry.csv",
    telemetryBytes: 1000,
    driver: "Nick",
    session: null,
    track: "autocross",
    trackName: "Autocross 2026",
    startedAt: "2026-09-18T10:00:00Z",
    finishedReason: "finished",
    profile: "wheel",
    detectedInput: null,
    device: null,
    physics: "native-1khz",
    simVersion: "0.6.6",
    synthetic: false,
    samples: 4000,
    assists: { traction: false, abs: false, autoShift: false },
    laps: [],
    driverId: `id-${over.driver ?? "Nick"}`,
    formatVersion: 3,
    sampleRateHz: 100,
    ...over,
    stats: {
      durationS: 40, distanceM: 685, laps: 1, bestLapS: null, bestLapRawS: null, bestLapNumber: 1,
      bestSectors: [], theoreticalBestS: null, totalCones: 0, totalOffCourse: 0, peakSpeedKph: 90,
      peakRpm: 12000, peakLatG: 1.5, peakBrakeG: 1.3, peakAccelG: 1.1, avgSpeedMps: 17,
      fullThrottleFrac: 0.4, brakingFrac: 0.2, offTrackS: 0, ffbClippedFrac: 0,
      ...over.stats,
    },
  } as SimRun;
}

const st = (bestLapS: number, extra: Record<string, unknown> = {}) =>
  ({ bestLapS, bestLapRawS: bestLapS, ...extra }) as never;
const FOUR = { simVersion: "0.7.4" };
const four = (t: number) => st(t, { vehicleModel: 3, physicsRev: 2 });
const at = (d: number) => `2026-09-2${d}T10:00:00Z`;

describe("board standing", () => {
  it("labels a board and places a run's driver on it", () => {
    const runs = [
      run({ runId: "j", driver: "Jordan", startedAt: at(1), stats: st(39) }),
      run({ runId: "n1", startedAt: at(2), stats: st(41) }),
      run({ runId: "n2", startedAt: at(3), stats: st(42) }),
      // Same course, different car: its own board, and not in this standing.
      run({ runId: "four", startedAt: at(4), ...FOUR, stats: four(38) }),
      // Same course, a pad: its own board too.
      run({ runId: "pad", startedAt: at(4), profile: "gamepad-xbox", stats: st(37) }),
    ];
    const s = boardStanding(runs, runs[2]!);
    expect(boardLabel(s.key, { era: true })).toBe("Autocross · Bicycle · Wheel · rev 1");
    expect(s.entry?.rank).toBe(2);
    expect(s.entry?.best).toBe(41);
    expect(s.leader?.driver).toBe("Jordan");
    expect(s.isDriversBest).toBe(false);
    expect(boardStanding(runs, runs[1]!).isDriversBest).toBe(true);
    expect(boardStanding(runs, runs[3]!).leader?.runId).toBe("four");
    expect(boardLabel(boardKeyOf(runs[4]!))).toBe("Autocross · Bicycle · Pad");
  });

  it("has no board for a run nothing on it ranks", () => {
    const s = boardStanding([], run({ runId: "tc", assists: { traction: true, abs: false, autoShift: false }, stats: st(40) }));
    expect(s.board).toBeNull();
    expect(s.entry).toBeNull();
  });

  it("names courses shortly", () => {
    expect(courseShort("autocross")).toBe("AX");
    expect(courseShort("accel")).toBe("Accel");
    expect(courseShort("gen-ax-K7Q2")).toBe("AX K7Q2");
    expect(courseName("autocross")).toBe("Autocross");
    expect(courseName("endurance")).toBe("Endurance");
    expect(courseName("gen-en-K7Q2")).toBe("Endurance K7Q2");
  });
});

describe("sessionResult", () => {
  it("measures a new best against the same board only, and says when it is the record", () => {
    const runs = [
      run({ runId: "bike-old", startedAt: at(1), stats: st(40) }),
      run({ runId: "four-old", startedAt: at(1), ...FOUR, stats: four(44) }),
      run({ runId: "j", driver: "Jordan", startedAt: at(2), ...FOUR, stats: four(41.5) }),
      run({ runId: "four-new", startedAt: at(3), ...FOUR, stats: four(42) }),
    ];
    const r = sessionResult(runs, runs[3]!)!;
    // Course and driver alone would have measured this against the bicycle's
    // 40 and called it 2 s slower. On its own board it is 2 s quicker.
    expect(r.previousBest).toBe(44);
    expect(r.improvement).toBeCloseTo(2, 6);
    expect(r.record).toBe(false);
    expect(r.standing.entry?.rank).toBe(2);
    expect(r.standing.leader?.driver).toBe("Jordan");
    expect(sessionResult(runs, runs[2]!)!.record).toBe(true);
  });

  it("is no result at all for a run that cannot rank", () => {
    const tc = run({ runId: "tc", assists: { traction: true, abs: false, autoShift: false }, stats: st(30) });
    expect(sessionResult([tc], tc)).toBeNull();
  });
});

describe("reference laps", () => {
  it("finds the driver's best and the leader's lap, only where the lap can be loaded", () => {
    const runs = [
      run({ runId: "j", driver: "Jordan", stats: st(39) }),
      run({ runId: "n-fast-gone", remote: true, telemetryObject: null, telemetryBytes: 0, stats: st(40) }),
      run({ runId: "n-slow", stats: st(41) }),
    ];
    expect(bestWatchable(runs, runs[2]!, "id-Nick")?.runId).toBe("n-slow");
    expect(leaderWatchable(runs, runs[2]!)?.runId).toBe("j");
    const gone = [{ ...runs[0]!, remote: true, telemetryObject: null, telemetryBytes: 0 }, runs[2]!];
    expect(leaderWatchable(gone, runs[1]!)).toBeNull();
  });
});

describe("bestPerCourse", () => {
  it("keeps courses apart instead of calling an accel run the day's best lap", () => {
    const runs = [
      ...[40.87, 41.2, 42].map((t, i) => run({ runId: `ax${i}`, stats: st(t) })),
      run({ runId: "acc", track: "accel", trackName: "Acceleration", stats: st(4.352) }),
      run({ runId: "untimed", track: "endurance", trackName: "Endurance 2026" }),
    ];
    expect(bestPerCourse(runs).map((c) => [c.short, c.best, c.runId])).toEqual([
      ["AX", 40.87, "ax0"],
      ["Accel", 4.352, "acc"],
    ]);
  });
});

describe("ghostCandidates, same car and ranked", () => {
  it("drops other models and unranked runs, and puts the viewer's own best first", () => {
    const mine = run({ runId: "mine", stats: st(41) });
    const list = [
      mine,
      run({ runId: "jordan", driver: "Jordan", stats: st(38) }),
      run({ runId: "my-pb", stats: st(39.5) }),
      run({ runId: "my-slow", stats: st(43) }),
      run({ runId: "four", ...FOUR, stats: four(36) }),
      run({ runId: "tc", assists: { traction: true, abs: false, autoShift: false }, stats: st(35) }),
    ];
    expect(ghostCandidates(list, mine).map((r) => r.runId)).toEqual(["jordan", "my-pb", "my-slow"]);
    expect(ghostCandidates(list, mine, "id-Nick").map((r) => r.runId)).toEqual(["my-pb", "jordan", "my-slow"]);
  });
});

describe("buildRecentRecords", () => {
  it("reports records and personal bests per board, newest first", () => {
    const runs = [
      run({ runId: "a", startedAt: "2026-09-20T10:00:00Z", stats: st(42) }),
      run({ runId: "b", driver: "Jordan", startedAt: "2026-09-20T11:00:00Z", stats: st(41) }),
      run({ runId: "c", startedAt: "2026-09-20T12:00:00Z", stats: st(41.5) }),
      run({ runId: "d", startedAt: "2026-09-20T13:00:00Z", stats: st(41.6) }),
      // Another course is another board: its first time is its record.
      run({ runId: "e", track: "accel", trackName: "Acceleration", startedAt: "2026-09-20T14:00:00Z", stats: st(4.35) }),
    ];
    const ev = buildRecentRecords(runs);
    expect(ev.map((e) => [e.runId, e.kind, e.previous])).toEqual([
      ["e", "record", null],
      ["c", "pb", 42],
      ["b", "record", 42],
      ["a", "record", null],
    ]);
    expect(buildRecentRecords(runs, 2)).toHaveLength(2);
  });

  it("does not compare a 4-wheel lap with a bicycle one", () => {
    const ev = buildRecentRecords([
      run({ runId: "bike", startedAt: at(1), stats: st(40) }),
      run({ runId: "four", startedAt: at(2), ...FOUR, stats: four(44) }),
    ]);
    // Both are the first time on their own board, so both are records.
    expect(ev.map((e) => [e.runId, e.kind])).toEqual([["four", "record"], ["bike", "record"]]);
  });
});

describe("time found says which car", () => {
  it("carries the model and era of each improvement", () => {
    const imp = buildImprovements([
      run({ runId: "a", startedAt: at(0), ...FOUR, stats: four(45) }),
      run({ runId: "b", startedAt: at(1), ...FOUR, stats: four(43) }),
    ]);
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ model: 3, era: 2 });
  });
});

describe("lapCounts", () => {
  it("is false for a lap that left the course, however the manifest says so", () => {
    expect(lapCounts({ valid: true, off: 0 })).toBe(true);
    expect(lapCounts({ off: 0 })).toBe(true);
    expect(lapCounts({ valid: false, off: 0 })).toBe(false);
    expect(lapCounts({ off: 1 })).toBe(false);
  });
});
