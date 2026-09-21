/* Courses change shape; times do not follow them.
 *
 * The 2026 autocross and endurance courses gained their slaloms in simulator
 * 0.6.0. A time from before that was set on a different course, and a board
 * that mixed the two would rank a lap through open road over one through the
 * cones. `predatesCourse` is the rule; `isRankable` and the push both apply
 * it. Generated courses are named by their seed and are new, so nothing on
 * them predates anything. */
import { describe, it, expect } from "vitest";
import {
  COURSE_REVISED_AT, generatedTrackId, isRankable, isTrackId, normaliseSeed, parseGeneratedId,
  predatesCourse, randomSeed, trackName, unrankedReason, type SimRun,
} from "../api";

const ME = "5c438ca3-9dee-45a7-bf15-4be3b98b5712";
function run(over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, runId: "r", dir: "C:/x/r", telemetryPath: "", telemetryBytes: 10,
    driver: "Nick", driverId: ME, session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: "2026-09-22T10:00:00Z", finishedReason: "finished", profile: "wheel", detectedInput: "wheel",
    device: null, physics: null, simVersion: "0.6.0", synthetic: false, samples: 4000,
    assists: { traction: false, abs: false, autoShift: false }, laps: [],
    stats: {
      durationS: 40, distanceM: 680, laps: 1, bestLapS: 41, bestLapRawS: 41, bestLapNumber: 1, bestSectors: [],
      theoreticalBestS: null, totalCones: 0, totalOffCourse: 0, peakSpeedKph: 0, peakRpm: 0, peakLatG: 0,
      peakBrakeG: 0, peakAccelG: 0, avgSpeedMps: 0, fullThrottleFrac: 0, brakingFrac: 0, offTrackS: 0,
      ffbClippedFrac: 0,
    },
    ...over,
  } as SimRun;
}

describe("predatesCourse", () => {
  const cutoff = COURSE_REVISED_AT.autocross!.at;

  it("is false for a run on the current course", () => {
    expect(predatesCourse(run())).toBe(false);
    expect(isRankable(run())).toBe(true);
  });

  it("goes by the simulator version when the run has one", () => {
    expect(predatesCourse(run({ simVersion: "0.5.7" }))).toBe(true);
    expect(predatesCourse(run({ simVersion: "0.6.0" }))).toBe(false);
    expect(predatesCourse(run({ simVersion: "0.10.0" }))).toBe(false);
    expect(predatesCourse(run({ simVersion: "fsae-sim 0.5.7" }))).toBe(true);
    // The version outranks the date: an un-updated rig driving after the
    // cutoff is still on the old course.
    expect(predatesCourse(run({ simVersion: "0.5.7", startedAt: "2026-10-01T00:00:00Z" }))).toBe(true);
  });

  it("catches a run whose version is newer than the revision but whose DATE is older", () => {
    // Every run recorded before 2026-09-19 09:55 UTC claims simVersion 1.0.0:
    // the literal was hand-written and never matched the shipping build (see
    // the simulator's commit "Every run ever recorded claims a version that
    // has never existed"). 1.0.0 sorts above 0.6.0, so a version-only rule
    // waves those runs through -- and one of them, driven two days before the
    // slaloms existed, sat on top of the autocross board.
    expect(predatesCourse(run({ simVersion: "1.0.0", startedAt: "2026-09-19T07:06:19Z" }))).toBe(true);
    expect(isRankable(run({ simVersion: "1.0.0", startedAt: "2026-09-19T07:06:19Z" }))).toBe(false);
  });

  it("does not blacklist 1.0.0 -- the simulator will reach it honestly one day", () => {
    // The fix is that an old DATE is its own proof, not that this one version
    // string is cursed. A genuine 1.0.0 driven after the cutoff must rank, or
    // this quietly breaks on the day the simulator ships its first major.
    expect(predatesCourse(run({ simVersion: "1.0.0", startedAt: "2026-12-01T00:00:00Z" }))).toBe(false);
    expect(isRankable(run({ simVersion: "1.0.0", startedAt: "2026-12-01T00:00:00Z" }))).toBe(true);
  });

  it("still lets the version condemn a run the date would have allowed", () => {
    // The case the version check exists for, unchanged: an un-updated rig
    // driving today is still driving the old course.
    expect(predatesCourse(run({ simVersion: "0.5.7", startedAt: "2026-10-01T00:00:00Z" }))).toBe(true);
  });

  it("goes by the start time when the run carries no version -- a shared row", () => {
    expect(predatesCourse(run({ simVersion: null, startedAt: "2026-09-19T20:00:00Z" }))).toBe(true);
    expect(predatesCourse(run({ simVersion: null, startedAt: cutoff }))).toBe(false);
    expect(predatesCourse(run({ simVersion: null, startedAt: "2026-09-21T02:00:00Z" }))).toBe(false);
    expect(predatesCourse(run({ simVersion: null, startedAt: null }))).toBe(true);
  });

  it("applies to both 2026 courses and to nothing else", () => {
    expect(predatesCourse(run({ track: "endurance", simVersion: "0.5.7" }))).toBe(true);
    // Endurance changed again in 0.6.1: a 0.6.0 endurance lap is stale, an
    // autocross one is not.
    expect(predatesCourse(run({ track: "endurance", simVersion: "0.6.0" }))).toBe(true);
    expect(predatesCourse(run({ track: "endurance", simVersion: "0.6.1" }))).toBe(false);
    expect(predatesCourse(run({ track: "autocross", simVersion: "0.6.0" }))).toBe(false);
    expect(predatesCourse(run({ track: "endurance", simVersion: null, startedAt: "2026-09-21T01:15:00Z" }))).toBe(true);
    expect(predatesCourse(run({ track: "mis", simVersion: "0.5.7" }))).toBe(false);
    expect(predatesCourse(run({ track: "gen-ax-K7Q2", simVersion: null, startedAt: "2026-09-01T00:00:00Z" }))).toBe(false);
  });

  it("is a reason the runs table can show", () => {
    const r = run({ simVersion: "0.5.7" });
    expect(isRankable(r)).toBe(false);
    expect(unrankedReason(r)).toMatch(/slaloms.*0\.6\.0/);
  });
});

describe("generated course ids", () => {
  it("are the simulator's, seed for seed", () => {
    expect(normaliseSeed(" k7q2 ")).toBe("K7Q2");
    expect(normaliseSeed("a b!c")).toBe("ABC");
    expect(normaliseSeed("x".repeat(30))).toHaveLength(12);
    expect(generatedTrackId("autocross", "k7q2")).toBe("gen-ax-K7Q2");
    expect(generatedTrackId("endurance", "")).toBe("gen-en-SDM26");
    expect(parseGeneratedId("gen-en-abc")).toEqual({ event: "endurance", seed: "ABC" });
    expect(parseGeneratedId("autocross")).toBeNull();
    expect(parseGeneratedId("gen-xx-ABC")).toBeNull();
  });

  it("are courses the launcher will accept, with a name", () => {
    expect(isTrackId("gen-ax-K7Q2")).toBe(true);
    expect(isTrackId("autocross")).toBe(true);
    expect(isTrackId("nurburgring")).toBe(false);
    expect(trackName("gen-ax-K7Q2")).toBe("Autocross K7Q2");
    expect(trackName("gen-en-SDM26")).toBe("Endurance SDM26");
    expect(trackName("autocross")).toBe("Autocross 2026");
    expect(trackName("unknown")).toBe("unknown");
  });

  it("random seeds are four characters from the readable alphabet", () => {
    const s = randomSeed(() => 0.5);
    expect(s).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(normaliseSeed(s)).toBe(s);
  });
});
