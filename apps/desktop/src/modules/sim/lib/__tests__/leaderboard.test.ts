import { describe, expect, it } from "vitest";
import {
  buildActivity, buildBoards, buildConsistencyBoards, buildImprovements, ghostCandidates,
  CONSISTENCY_MIN_RUNS, CONSISTENCY_WINDOW,
} from "../leaderboard";
import { fmtGap, fmtTime, isRankable, unrankedReason, type SimRun } from "../../api";

/** A run with sensible defaults; every test overrides only what it is about. */
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
    device: null,
    physics: "native-1khz",
    // A believable version, deliberately. This fixture used to say "1.0.0",
    // copied from real manifests -- which is exactly the string the simulator
    // stamped on every run before 2026-09-19 and which named a build that had
    // never shipped. `predatesCourse` no longer takes it at its word, so a
    // fixture carrying it describes a stale run and ranks nowhere.
    simVersion: "0.6.6",
    synthetic: false,
    samples: 4000,
    assists: { traction: false, abs: false, autoShift: false },
    laps: [],
    // One account per NAME by default, so a fixture that names two drivers
    // gets two accounts. A test that cares about the distinction sets
    // `driverId` itself.
    driverId: `id-${over.driver ?? "Nick"}`,
    // Current format unless a test says otherwise: the fixtures describe runs
    // a simulator would write today, and the older format is a case tested
    // deliberately rather than inherited by accident.
    formatVersion: 2,
    sampleRateHz: 100,
    ...over,
    stats: {
      durationS: 40,
      distanceM: 685,
      laps: 1,
      bestLapS: null,
      bestLapRawS: null,
      bestLapNumber: 1,
      bestSectors: [],
      theoreticalBestS: null,
      totalCones: 0,
      totalOffCourse: 0,
      peakSpeedKph: 90,
      peakRpm: 12000,
      peakLatG: 1.5,
      peakBrakeG: 1.3,
      peakAccelG: 1.1,
      avgSpeedMps: 17,
      fullThrottleFrac: 0.4,
      brakingFrac: 0.2,
      offTrackS: 0,
      ffbClippedFrac: 0,
      ...over.stats,
    },
  } as SimRun;
}

describe("isRankable", () => {
  it("ranks a clean human run with a lap", () => {
    expect(isRankable(run({ runId: "a", stats: { bestLapS: 41 } as never }))).toBe(true);
  });

  it("does not rank a run with no completed lap", () => {
    const r = run({ runId: "a" });
    expect(isRankable(r)).toBe(false);
    expect(unrankedReason(r)).toBe("no completed lap");
  });

  it("does not rank a run driven with assists, and says which", () => {
    const r = run({
      runId: "a",
      assists: { traction: true, abs: false, autoShift: true },
      stats: { bestLapS: 38 } as never,
    });
    expect(isRankable(r)).toBe(false);
    expect(unrankedReason(r)).toBe("traction control, automatic gearbox was on");
  });

  it("does not rank the robot driver", () => {
    const r = run({ runId: "a", synthetic: true, stats: { bestLapS: 30 } as never });
    expect(isRankable(r)).toBe(false);
    expect(unrankedReason(r)).toBe("driven by the robot driver, not a person");
  });

  it("does not rank a run whose driver was never signed in", () => {
    // Somebody opened the simulator directly and typed a name. It is a real
    // drive and it replays fine, but a typed name is not an identity and the
    // board does not take its word for who set the time.
    const r = run({ runId: "a", driverId: null, stats: { bestLapS: 30 } as never });
    expect(isRankable(r)).toBe(false);
    expect(unrankedReason(r)).toBe("not launched from Helios, so the driver is unverified");
  });

  it("two people who share a display name are still two drivers", () => {
    const a = run({ runId: "a", driver: "N. Murray", driverId: "id-1", stats: { bestLapS: 41 } as never });
    const b = run({ runId: "b", driver: "N. Murray", driverId: "id-2", stats: { bestLapS: 39 } as never });
    const board = buildBoards([a, b])[0]!;
    expect(board.entries).toHaveLength(2);
    expect(board.entries.map((e) => e.driverId)).toEqual(["id-2", "id-1"]);
  });

  it("one driver who renames themselves is still one driver", () => {
    // Grouping by display name put this person at ranks 1 and 3 with a
    // teammate between them, each row claiming a single run, and threw away
    // every sector best and every second of improvement across the rename.
    const runs = [
      run({ runId: "old", driver: "Nick", driverId: "id-nick",
            startedAt: "2026-09-01T10:00:00Z",
            stats: { bestLapS: 39.0, bestSectors: [13.0, 13.0, 13.0] } as never }),
      run({ runId: "new", driver: "Nick M.", driverId: "id-nick",
            startedAt: "2026-09-08T10:00:00Z",
            stats: { bestLapS: 38.4, bestSectors: [12.8, 12.9, 12.7] } as never }),
      run({ runId: "aidan", driver: "Aidan", driverId: "id-aidan",
            stats: { bestLapS: 38.9 } as never }),
    ];
    const board = buildBoards(runs)[0]!;
    expect(board.entries).toHaveLength(2);
    const nick = board.entries.find((e) => e.driverId === "id-nick")!;
    expect(nick.runs).toBe(2);
    expect(nick.best).toBe(38.4);
    expect(nick.driver).toBe("Nick M.");        // the name from the latest run
    expect(nick.bestSectors).toEqual([12.8, 12.9, 12.7]);
    expect(nick.rank).toBe(1);
    // And the improvement across the rename is still found.
    const im = buildImprovements(runs);
    expect(im).toHaveLength(1);
    expect(im[0]!.driver).toBe("Nick M.");
    expect(im[0]!.gained).toBeCloseTo(0.6, 6);
  });
});

describe("buildBoards", () => {
  it("ranks drivers by their best scored lap and reports the gap", () => {
    const boards = buildBoards([
      run({ runId: "a", driver: "Nick", stats: { bestLapS: 41.1, bestSectors: [13, 14, 14.1] } as never }),
      run({ runId: "b", driver: "Nick", stats: { bestLapS: 38.4, bestSectors: [12.5, 13.2, 12.7] } as never }),
      run({ runId: "c", driver: "Aidan", stats: { bestLapS: 39.9, bestSectors: [12.9, 13.5, 13.5] } as never }),
    ]);
    expect(boards).toHaveLength(1);
    const b = boards[0]!;
    expect(b.entries.map((e) => e.driver)).toEqual(["Nick", "Aidan"]);
    expect(b.entries[0]!.best).toBe(38.4);
    expect(b.entries[0]!.gap).toBe(0);
    expect(b.entries[0]!.runId).toBe("b");
    expect(b.entries[1]!.gap).toBeCloseTo(1.5, 6);
    expect(b.entries[0]!.runs).toBe(2);
    expect(b.runCount).toBe(3);
  });

  it("takes a driver's sector bests ACROSS their runs, not from one lap", () => {
    // Neither run is best in every sector, which is the whole point of a
    // theoretical: 12.5 + 13.2 + 12.7 is a lap nobody has actually driven.
    const boards = buildBoards([
      run({ runId: "a", driver: "Nick", stats: { bestLapS: 41.1, bestSectors: [12.5, 14.0, 14.6] } as never }),
      run({ runId: "b", driver: "Nick", stats: { bestLapS: 38.4, bestSectors: [13.0, 13.2, 12.7] } as never }),
    ]);
    const e = boards[0]!.entries[0]!;
    expect(e.bestSectors).toEqual([12.5, 13.2, 12.7]);
    expect(e.theoretical).toBeCloseTo(38.4, 6);
    // And it is genuinely under the best lap actually driven.
    expect(e.theoretical!).toBeLessThanOrEqual(e.best);
  });

  it("holds a team sector record across drivers", () => {
    const boards = buildBoards([
      run({ runId: "a", driver: "Nick", stats: { bestLapS: 40, bestSectors: [12.5, 14.0, 13.5] } as never }),
      run({ runId: "b", driver: "Aidan", stats: { bestLapS: 41, bestSectors: [13.0, 13.2, 14.8] } as never }),
    ]);
    expect(boards[0]!.sectorRecords).toEqual([12.5, 13.2, 13.5]);
    expect(boards[0]!.teamTheoretical).toBeCloseTo(39.2, 6);
  });

  it("returns no theoretical when a sector was never completed", () => {
    const boards = buildBoards([
      run({ runId: "a", stats: { bestLapS: 40, bestSectors: [12.5, null, 13.5] } as never }),
    ]);
    expect(boards[0]!.entries[0]!.theoretical).toBeNull();
    expect(boards[0]!.teamTheoretical).toBeNull();
  });

  it("keeps a separate board per course, busiest first", () => {
    const boards = buildBoards([
      run({ runId: "a", track: "endurance", trackName: "Endurance 2026", stats: { bestLapS: 90 } as never }),
      run({ runId: "b", track: "autocross", stats: { bestLapS: 41 } as never }),
      run({ runId: "c", track: "autocross", driver: "Aidan", stats: { bestLapS: 42 } as never }),
    ]);
    expect(boards.map((b) => b.track)).toEqual(["autocross", "endurance"]);
  });

  it("counts unranked runs but does not rank them", () => {
    const boards = buildBoards([
      run({ runId: "a", stats: { bestLapS: 41 } as never }),
      run({ runId: "b", driver: "Robot", synthetic: true, stats: { bestLapS: 30 } as never }),
      run({ runId: "c", driver: "Aidan", assists: { traction: true, abs: false, autoShift: false }, stats: { bestLapS: 35 } as never }),
      run({ runId: "d", driver: "Walk-up", driverId: null, stats: { bestLapS: 33 } as never }),
    ]);
    const b = boards[0]!;
    expect(b.entries.map((e) => e.driver)).toEqual(["Nick"]);
    expect(b.runCount).toBe(1);
    expect(b.unrankedCount).toBe(3);
  });

  it("is empty for an empty archive", () => {
    expect(buildBoards([])).toEqual([]);
  });
});

describe("buildImprovements", () => {
  it("measures from the FIRST run chronologically, not the first in the list", () => {
    // The listing arrives newest-first, which is how a naive implementation
    // gets this exactly backwards and reports a driver getting slower.
    const improvements = buildImprovements([
      run({ runId: "new", startedAt: "2026-09-18T12:00:00Z", stats: { bestLapS: 38.4 } as never }),
      run({ runId: "mid", startedAt: "2026-09-18T11:00:00Z", stats: { bestLapS: 40.0 } as never }),
      run({ runId: "old", startedAt: "2026-09-18T10:00:00Z", stats: { bestLapS: 44.2 } as never }),
    ]);
    expect(improvements).toHaveLength(1);
    expect(improvements[0]!.first).toBe(44.2);
    expect(improvements[0]!.best).toBe(38.4);
    expect(improvements[0]!.gained).toBeCloseTo(5.8, 6);
    expect(improvements[0]!.runs).toBe(3);
  });

  it("needs two runs on a course before it says anything", () => {
    expect(buildImprovements([run({ runId: "a", stats: { bestLapS: 41 } as never })])).toEqual([]);
  });

  it("says nothing about a driver whose first run is still their best", () => {
    // A row reading "-0.000 s" in the same green as a real gain is worse than
    // no row at all.
    expect(buildImprovements([
      run({ runId: "a", startedAt: "2026-09-01T10:00:00Z", stats: { bestLapS: 41.0 } as never }),
      run({ runId: "b", startedAt: "2026-09-02T10:00:00Z", stats: { bestLapS: 43.5 } as never }),
    ])).toEqual([]);
  });

  it("keeps courses separate", () => {
    const improvements = buildImprovements([
      run({ runId: "a", startedAt: "2026-09-01T10:00:00Z", stats: { bestLapS: 44 } as never }),
      run({ runId: "b", startedAt: "2026-09-02T10:00:00Z", stats: { bestLapS: 41 } as never }),
      run({ runId: "c", track: "endurance", startedAt: "2026-09-01T10:00:00Z", stats: { bestLapS: 100 } as never }),
      run({ runId: "d", track: "endurance", startedAt: "2026-09-02T10:00:00Z", stats: { bestLapS: 95 } as never }),
    ]);
    expect(improvements.map((i) => i.track).sort()).toEqual(["autocross", "endurance"]);
    expect(improvements[0]!.gained).toBeCloseTo(5, 6); // endurance, the bigger gain
  });
});

describe("buildActivity", () => {
  it("totals wheel time and finds the fastest real lap", () => {
    const a = buildActivity([
      run({ runId: "a", driver: "Nick", stats: { bestLapS: 41, durationS: 50, distanceM: 700, laps: 1, totalCones: 2 } as never }),
      run({ runId: "b", driver: "Aidan", stats: { bestLapS: 39, durationS: 45, distanceM: 690, laps: 1, totalCones: 0 } as never }),
      // The robot is quicker than everyone and must not hold the record.
      run({ runId: "c", driver: "Robot", synthetic: true, stats: { bestLapS: 30, durationS: 40, distanceM: 685, laps: 1, totalCones: 0 } as never }),
    ]);
    expect(a.runs).toBe(3);
    expect(a.drivers).toBe(3);
    expect(a.secondsDriven).toBe(135);
    expect(a.metresDriven).toBe(2075);
    expect(a.laps).toBe(3);
    expect(a.cones).toBe(2);
    expect(a.fastest?.driver).toBe("Aidan");
    expect(a.fastest?.time).toBe(39);
  });

  it("has no fastest lap when nothing is rankable", () => {
    expect(buildActivity([run({ runId: "a" })]).fastest).toBeNull();
  });
});

describe("ghostCandidates", () => {
  it("offers the same course only, quickest first, never itself", () => {
    const mine = run({ runId: "mine", stats: { bestLapS: 41 } as never });
    const list = [
      mine,
      run({ runId: "slow", stats: { bestLapS: 45 } as never }),
      run({ runId: "fast", stats: { bestLapS: 38 } as never }),
      run({ runId: "other-course", track: "endurance", stats: { bestLapS: 20 } as never }),
      run({ runId: "no-lap" }),
    ];
    expect(ghostCandidates(list, mine).map((r) => r.runId)).toEqual(["fast", "slow"]);
  });
});

describe("formatting", () => {
  it("writes lap times the way a timing screen does", () => {
    expect(fmtTime(41.121)).toBe("41.121");
    expect(fmtTime(90.5)).toBe("1:30.500");
    expect(fmtTime(3.4)).toBe("3.400");
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(Number.NaN)).toBe("—");
  });

  it("always signs a gap", () => {
    expect(fmtGap(0.482)).toBe("+0.482");
    expect(fmtGap(-0.482)).toBe("−0.482");
    expect(fmtGap(0)).toBe("+0.000");
    expect(fmtGap(null)).toBe("—");
  });
});

describe("the older manifest format", () => {
  // Version 1 wrote `sectors` as cumulative splits with the final one missing,
  // and `bestLapRawS` as the quickest RAW lap rather than the raw time of the
  // best scored one. Both parse, both look like lap times, and both are wrong;
  // the board's job is to not draw them.
  const v1 = (over: Partial<SimRun> & { runId: string }) => run({ ...over, formatVersion: 1 });

  it("keeps a version 1 run on the board -- its lap time was measured", () => {
    const board = buildBoards([
      v1({ runId: "a", stats: { bestLapS: 41, bestSectors: [12, 25, 41] } as never }),
    ]);
    expect(board[0]!.entries).toHaveLength(1);
    expect(board[0]!.entries[0]!.best).toBe(41);
  });

  it("but does not show its raw time, which belongs to a different lap", () => {
    const board = buildBoards([
      v1({ runId: "a", stats: { bestLapS: 47, bestLapRawS: 40 } as never }),
    ]);
    expect(board[0]!.entries[0]!.bestRaw).toBeNull();
  });

  it("and does not let its cumulative splits become a theoretical best", () => {
    // 12 / 25 / 41 are running totals. Summed they are 78 -- nearly twice the
    // 41 s lap they came from, which is the tell the original bug left.
    const board = buildBoards([
      v1({ runId: "a", stats: { bestLapS: 41, bestSectors: [12, 25, 41] } as never }),
    ]);
    expect(board[0]!.entries[0]!.bestSectors).toEqual([]);
    expect(board[0]!.entries[0]!.theoretical).toBeNull();
    expect(board[0]!.sectorRecords).toEqual([]);
  });

  it("a current run on the same course is unaffected by it", () => {
    const board = buildBoards([
      v1({ runId: "old", driver: "Old", stats: { bestLapS: 41, bestSectors: [12, 25, 41] } as never }),
      run({ runId: "new", driver: "New", stats: { bestLapS: 42, bestLapRawS: 42, bestSectors: [13, 14, 15] } as never }),
    ]);
    const fresh = board[0]!.entries.find((e) => e.driver === "New")!;
    expect(fresh.bestSectors).toEqual([13, 14, 15]);
    expect(fresh.theoretical).toBeCloseTo(42, 6);
    expect(board[0]!.sectorRecords).toEqual([13, 14, 15]);
  });
});

describe("the raw column is the best lap's own raw time", () => {
  it("carries the raw time from the run the best lap came from", () => {
    const board = buildBoards([
      run({ runId: "a", stats: { bestLapS: 50, bestLapRawS: 44 } as never }),
      run({ runId: "b", stats: { bestLapS: 47, bestLapRawS: 41 } as never }),
    ]);
    const e = board[0]!.entries[0]!;
    expect(e.best).toBe(47);
    // Not 44: that raw belongs to the run that was not the best.
    expect(e.bestRaw).toBe(41);
    expect(e.best - e.bestRaw!).toBeCloseTo(6, 6);
  });

  it("is null when the run never recorded one", () => {
    const board = buildBoards([run({ runId: "a", stats: { bestLapS: 47 } as never })]);
    expect(board[0]!.entries[0]!.bestRaw).toBeNull();
  });
});

describe("buildConsistencyBoards", () => {
  /** `times.length` clean runs for one driver, oldest first. */
  function series(driver: string, times: number[], from = "2026-09-01T00:00:00Z"): SimRun[] {
    return times.map((t, i) =>
      run({
        runId: `${driver}-${i}`,
        driver,
        startedAt: new Date(Date.parse(from) + i * 3_600_000).toISOString(),
        stats: { bestLapS: t, bestLapRawS: t } as SimRun["stats"],
      }),
    );
  }

  it("ranks by the mean of the newest window, not the whole history", () => {
    // Nick: 10 slow learning runs then WINDOW quick ones. Only the quick ones count.
    const nick = series("Nick", [...Array(10).fill(50), ...Array(CONSISTENCY_WINDOW).fill(40)]);
    // Ralf: WINDOW runs at 41 every time.
    const ralf = series("Ralf", Array(CONSISTENCY_WINDOW).fill(41));
    const [board] = buildConsistencyBoards([...ralf, ...nick]);
    expect(board?.entries.map((e) => e.driver)).toEqual(["Nick", "Ralf"]);
    expect(board?.entries[0]?.average).toBeCloseTo(40, 6);
    expect(board?.entries[0]?.counted).toBe(CONSISTENCY_WINDOW);
    expect(board?.entries[1]?.gap).toBeCloseTo(1, 6);
  });

  it("a faster single lap does not beat a better average", () => {
    const steady = series("Steady", [40, 40, 40, 40]);
    const hero = series("Hero", [38, 44, 44, 44]);
    const [board] = buildConsistencyBoards([...hero, ...steady]);
    expect(board?.entries[0]?.driver).toBe("Steady");
    expect(board?.entries[1]?.best).toBe(38);
    expect(board?.entries[1]?.spread).toBeGreaterThan(2);
    expect(board?.entries[0]?.spread).toBe(0);
  });

  it("does not depend on the order the listing arrived in", () => {
    const runs = series("Nick", [50, 50, 50, 40, 40, 40]);
    const a = buildConsistencyBoards(runs, 3)[0]!.entries[0]!;
    const b = buildConsistencyBoards([...runs].reverse(), 3)[0]!.entries[0]!;
    expect(a.average).toBeCloseTo(40, 6);
    expect(b.average).toBeCloseTo(a.average, 6);
  });

  it("needs a minimum of clean runs before it ranks, and says who is short", () => {
    const short = series("New", Array(CONSISTENCY_MIN_RUNS - 1).fill(42));
    const enough = series("Old", Array(CONSISTENCY_MIN_RUNS).fill(43));
    const [board] = buildConsistencyBoards([...short, ...enough]);
    expect(board?.entries.map((e) => e.driver)).toEqual(["Old"]);
    expect(board?.pending).toEqual([{ driverId: "id-New", driver: "New", counted: CONSISTENCY_MIN_RUNS - 1 }]);
  });

  it("off-course and aided runs stay out of the average instead of dragging it", () => {
    const clean = series("Nick", [40, 40, 40]);
    const off = run({
      runId: "off", driver: "Nick", startedAt: "2026-09-02T00:00:00Z",
      laps: [{ lap: 1, raw: 60, cones: 0, off: 1, total: 60, valid: false, sectors: [], startedAtS: 0 } as never],
      stats: { bestLapS: null, bestLapRawS: null, totalOffCourse: 1 } as SimRun["stats"],
    });
    const aided = run({ runId: "tc", driver: "Nick", startedAt: "2026-09-02T01:00:00Z",
      assists: { traction: true, abs: false, autoShift: false }, stats: { bestLapS: 30 } as SimRun["stats"] });
    const [board] = buildConsistencyBoards([...clean, off, aided]);
    expect(board?.entries[0]?.average).toBeCloseTo(40, 6);
    expect(board?.entries[0]?.counted).toBe(3);
  });

  it("points at the quickest run inside the window", () => {
    const nick = series("Nick", [45, 41, 43, 42]);
    const [board] = buildConsistencyBoards(nick);
    expect(board?.entries[0]?.runId).toBe("Nick-1");
    expect(board?.entries[0]?.best).toBe(41);
    expect(board?.entries[0]?.latest).toBe(nick[3]!.startedAt);
  });
});
